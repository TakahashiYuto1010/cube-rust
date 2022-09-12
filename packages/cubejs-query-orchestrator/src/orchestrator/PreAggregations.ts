import crypto from 'crypto';
import R from 'ramda';
import {
  addSecondsToLocalTimestamp,
  extractDate,
  FROM_PARTITION_RANGE,
  getEnv,
  inDbTimeZone,
  timeSeries,
  MAX_SOURCE_ROW_LIMIT,
  TO_PARTITION_RANGE,
  BUILD_RANGE_START_LOCAL,
  BUILD_RANGE_END_LOCAL,
  utcToLocalTimeZone,
} from '@cubejs-backend/shared';

import { cancelCombinator, SaveCancelFn, DriverInterface, BaseDriver,
  DownloadTableData,
  InlineTable,
  StreamOptions,
  UnloadOptions } from '@cubejs-backend/base-driver';
import { RedisCacheDriver } from './RedisCacheDriver';
import { LocalCacheDriver } from './LocalCacheDriver';
import { Query, QueryCache, QueryTuple, QueryWithParams } from './QueryCache';
import { ContinueWaitError } from './ContinueWaitError';
import { DriverFactory, DriverFactoryByDataSource } from './DriverFactory';
import { CacheDriverInterface } from './cache-driver.interface';
import { QueryQueue } from './QueryQueue';
import { LargeStreamWarning } from './StreamObjectsCounter';

/// Name of the inline table containing the lambda rows.
export const LAMBDA_TABLE_PREFIX = 'lambda';

function encodeTimeStamp(time) {
  return Math.floor(time / 1000).toString(32);
}

function decodeTimeStamp(time) {
  return parseInt(time, 32) * 1000;
}

function version(cacheKey) {
  let result = '';

  const hashCharset = 'abcdefghijklmnopqrstuvwxyz012345';
  const digestBuffer = crypto.createHash('md5').update(JSON.stringify(cacheKey)).digest();

  let residue = 0;
  let shiftCounter = 0;

  for (let i = 0; i < 5; i++) {
    const byte = digestBuffer.readUInt8(i);
    shiftCounter += 8;
    // eslint-disable-next-line operator-assignment,no-bitwise
    residue = (byte << (shiftCounter - 8)) | residue;
    // eslint-disable-next-line no-bitwise
    while (residue >> 5) {
      result += hashCharset.charAt(residue % 32);
      shiftCounter -= 5;
      // eslint-disable-next-line operator-assignment,no-bitwise
      residue = residue >> 5;
    }
  }

  result += hashCharset.charAt(residue % 32);

  return result;
}

// There’re community developed and custom drivers which not always up-to-date with latest BaseDriver.
// Extra defence for drivers that don't expose now() yet.
function nowTimestamp(client: DriverInterface) {
  return client.nowTimestamp?.() ?? new Date().getTime();
}

// Returns the oldest timestamp, if any.
export function getLastUpdatedAtTimestamp(timestamps: (number | undefined)[]): number | undefined {
  timestamps = timestamps.filter(t => t !== undefined);
  if (timestamps.length === 0) {
    return undefined;
  } else {
    return Math.min(...timestamps);
  }
}

function getStructureVersion(preAggregation) {
  return version(
    preAggregation.indexesSql && preAggregation.indexesSql.length ?
      [preAggregation.loadSql, preAggregation.indexesSql] :
      preAggregation.loadSql
  );
}

type VersionEntry = {
  // eslint-disable-next-line camelcase
  table_name: string,
  // eslint-disable-next-line camelcase
  content_version: string,
  // eslint-disable-next-line camelcase
  structure_version: string,
  // eslint-disable-next-line camelcase
  last_updated_at: number,
  // eslint-disable-next-line camelcase
  build_range_end?: string,
  // eslint-disable-next-line camelcase
  naming_version?: number
};

type TableCacheEntry = {
  // eslint-disable-next-line camelcase
  table_name?: string;
  TABLE_NAME?: string;
  // eslint-disable-next-line camelcase
  build_range_end?: string;
};

type QueryDateRange = [string, string];

type PartitionRanges = {
  buildRange: QueryDateRange,
  partitionRanges: QueryDateRange[],
};

type IndexDescription = {
  sql: QueryWithParams;
  indexName: string;
};

export type LambdaOptions = {
  maxSourceRows: number
};

export type LambdaQuery = {
  sqlAndParams: QueryWithParams,
  cacheKeyQueries: any[],
};

export type PreAggregationDescription = {
  preAggregationsSchema: string;
  type: 'rollup' | 'originalSql';
  preAggregationId: string;
  priority: number;
  dataSource: string;
  external: boolean;
  previewSql: QueryWithParams;
  timezone: string;
  indexesSql: IndexDescription[];
  invalidateKeyQueries: QueryWithParams[];
  sql: QueryWithParams;
  loadSql: QueryWithParams;
  tableName: string;
  matchedTimeDimensionDateRange: QueryDateRange;
  granularity: string;
  partitionGranularity: string;
  preAggregationStartEndQueries: [QueryWithParams, QueryWithParams];
  timestampFormat: string;
  expandedPartition: boolean;
  unionWithSourceData: LambdaOptions;
  buildRangeEnd?: string;
};

const tablesToVersionEntries = (schema, tables: TableCacheEntry[]): VersionEntry[] => R.sortBy(
  table => -table.last_updated_at,
  tables.map(table => {
    const match = (table.table_name || table.TABLE_NAME).match(/(.+)_(.+)_(.+)_(.+)/);

    if (!match) {
      return null;
    }

    const entity: any = {
      table_name: `${schema}.${match[1]}`,
      content_version: match[2],
      structure_version: match[3],
    };

    if (match[4].length < 13) {
      entity.last_updated_at = decodeTimeStamp(match[4]);
      entity.naming_version = 2;
    } else {
      entity.last_updated_at = parseInt(match[4], 10);
    }

    if (table.build_range_end) {
      entity.build_range_end = table.build_range_end;
    }

    return entity;
  }).filter(R.identity)
);

type PreAggregationLoadCacheOptions = {
  requestId?: string,
  dataSource: string,
  tablePrefixes?: string[],
};

type VersionEntriesObj = {
  versionEntries: VersionEntry[],
  byStructure: { [key: string]: VersionEntry },
  byContent: { [key: string]: VersionEntry },
  byTableName: { [key: string]: VersionEntry },
};

class PreAggregationLoadCache {
  private redisPrefix: string;

  private driverFactory: DriverFactory;

  private queryCache: any;

  // eslint-disable-next-line no-use-before-define
  private preAggregations: PreAggregations;

  private queryResults: any;

  private cacheDriver: CacheDriverInterface;

  private externalDriverFactory: any;

  private requestId: any;

  private versionEntries: { [redisKey: string]: Promise<VersionEntriesObj> };

  private tables: { [redisKey: string]: TableCacheEntry[] };

  // TODO this is in memory cache structure as well however it depends on
  // data source only and load cache is per data source for now.
  // Make it per data source key in case load cache scope is broaden.
  private queryStageState: any;

  private dataSource: string;

  private tablePrefixes: string[] | null;

  public constructor(
    redisPrefix,
    clientFactory: DriverFactory,
    queryCache,
    preAggregations,
    options: PreAggregationLoadCacheOptions = { dataSource: 'default' }
  ) {
    this.redisPrefix = `${redisPrefix}_${options.dataSource}`;
    this.dataSource = options.dataSource;
    this.driverFactory = clientFactory;
    this.queryCache = queryCache;
    this.preAggregations = preAggregations;
    this.queryResults = {};
    this.cacheDriver = preAggregations.cacheDriver;
    this.externalDriverFactory = preAggregations.externalDriverFactory;
    this.requestId = options.requestId;
    this.tablePrefixes = options.tablePrefixes;
    this.versionEntries = {};
    this.tables = {};
  }

  protected async tablesFromCache(preAggregation, forceRenew?) {
    let tables = forceRenew ? null : await this.cacheDriver.get(this.tablesRedisKey(preAggregation));
    if (!tables) {
      tables = await this.preAggregations.getLoadCacheQueue(this.dataSource).executeInQueue(
        'query',
        `Fetch tables for ${preAggregation.preAggregationsSchema}`,
        {
          preAggregation, requestId: this.requestId
        },
        0,
        { requestId: this.requestId }
      );
    }
    return tables;
  }

  public async fetchTables(preAggregation: PreAggregationDescription) {
    if (preAggregation.external && !this.externalDriverFactory) {
      throw new Error('externalDriverFactory is not provided. Please make sure @cubejs-backend/cubestore-driver is installed and use CUBEJS_DEV_MODE=true or provide Cube Store connection env variables for production usage.');
    }

    const newTables = await this.fetchTablesNoCache(preAggregation);
    await this.cacheDriver.set(
      this.tablesRedisKey(preAggregation),
      newTables,
      this.preAggregations.options.preAggregationsSchemaCacheExpire || 60 * 60
    );
    return newTables;
  }

  private async fetchTablesNoCache(preAggregation: PreAggregationDescription) {
    const client = preAggregation.external ?
      await this.externalDriverFactory() :
      await this.driverFactory();
    if (this.tablePrefixes && client.getPrefixTablesQuery && this.preAggregations.options.skipExternalCacheAndQueue) {
      return client.getPrefixTablesQuery(preAggregation.preAggregationsSchema, this.tablePrefixes);
    }
    return client.getTablesQuery(preAggregation.preAggregationsSchema);
  }

  public tablesRedisKey(preAggregation: PreAggregationDescription) {
    return `SQL_PRE_AGGREGATIONS_TABLES_${this.redisPrefix}_${preAggregation.dataSource}${preAggregation.preAggregationsSchema}${preAggregation.external ? '_EXT' : ''}`;
  }

  protected async getTablesQuery(preAggregation) {
    const redisKey = this.tablesRedisKey(preAggregation);
    if (!this.tables[redisKey]) {
      const tables = this.preAggregations.options.skipExternalCacheAndQueue && preAggregation.external ?
        await this.fetchTablesNoCache(preAggregation) :
        await this.tablesFromCache(preAggregation);
      if (tables === undefined) {
        throw new Error('Pre-aggregation tables are undefined.');
      }
      this.tables[redisKey] = tables;
    }
    return this.tables[redisKey];
  }

  private async calculateVersionEntries(preAggregation): Promise<VersionEntriesObj> {
    let versionEntries = tablesToVersionEntries(
      preAggregation.preAggregationsSchema,
      await this.getTablesQuery(preAggregation)
    );
    // It presumes strong consistency guarantees for external pre-aggregation tables ingestion
    if (!preAggregation.external) {
      // eslint-disable-next-line
      const [active, toProcess, queries] = await this.fetchQueryStageState();
      const targetTableNamesInQueue = (Object.keys(queries))
        // eslint-disable-next-line no-use-before-define
        .map(q => PreAggregations.targetTableName(queries[q].query.newVersionEntry));

      versionEntries = versionEntries.filter(
        // eslint-disable-next-line no-use-before-define
        e => targetTableNamesInQueue.indexOf(PreAggregations.targetTableName(e)) === -1
      );
    }

    const byContent: { [key: string]: VersionEntry } = {};
    const byStructure: { [key: string]: VersionEntry } = {};
    const byTableName: { [key: string]: VersionEntry } = {};

    versionEntries.forEach(e => {
      const contentKey = `${e.table_name}_${e.content_version}`;
      if (!byContent[contentKey]) {
        byContent[contentKey] = e;
      }
      const structureKey = `${e.table_name}_${e.structure_version}`;
      if (!byStructure[structureKey]) {
        byStructure[structureKey] = e;
      }
      if (!byTableName[e.table_name]) {
        byTableName[e.table_name] = e;
      }
    });

    return { versionEntries, byContent, byStructure, byTableName };
  }

  public async getVersionEntries(preAggregation): Promise<VersionEntriesObj> {
    if (this.tablePrefixes && !this.tablePrefixes.find(p => preAggregation.tableName.split('.')[1].startsWith(p))) {
      throw new Error(`Load cache tries to load table ${preAggregation.tableName} outside of tablePrefixes filter: ${this.tablePrefixes.join(', ')}`);
    }
    const redisKey = this.tablesRedisKey(preAggregation);
    if (!this.versionEntries[redisKey]) {
      this.versionEntries[redisKey] = this.calculateVersionEntries(preAggregation).catch(e => {
        delete this.versionEntries[redisKey];
        throw e;
      });
    }
    return this.versionEntries[redisKey];
  }

  protected async keyQueryResult(sqlQuery: QueryWithParams, waitForRenew, priority) {
    const [query, values, queryOptions]: QueryTuple = Array.isArray(sqlQuery) ? sqlQuery : [sqlQuery, [], {}];

    if (!this.queryResults[this.queryCache.queryRedisKey([query, values])]) {
      this.queryResults[this.queryCache.queryRedisKey([query, values])] = await this.queryCache.cacheQueryResult(
        query,
        values,
        [query, values],
        60 * 60,
        {
          renewalThreshold: this.queryCache.options.refreshKeyRenewalThreshold
            || queryOptions?.renewalThreshold || 2 * 60,
          renewalKey: [query, values],
          waitForRenew,
          priority,
          requestId: this.requestId,
          dataSource: this.dataSource,
          useInMemory: true,
          external: queryOptions?.external
        }
      );
    }
    return this.queryResults[this.queryCache.queryRedisKey([query, values])];
  }

  protected hasKeyQueryResult(keyQuery) {
    return !!this.queryResults[this.queryCache.queryRedisKey(keyQuery)];
  }

  protected async getQueryStage(stageQueryKey) {
    const queue = await this.preAggregations.getQueue(this.dataSource);
    await this.fetchQueryStageState(queue);
    return queue.getQueryStage(stageQueryKey, undefined, this.queryStageState);
  }

  protected async fetchQueryStageState(queue?) {
    queue = queue || await this.preAggregations.getQueue(this.dataSource);
    if (!this.queryStageState) {
      this.queryStageState = await queue.fetchQueryStageState();
    }
    return this.queryStageState;
  }

  protected async reset(preAggregation) {
    await this.tablesFromCache(preAggregation, true);
    this.tables = {};
    this.queryStageState = undefined;
    this.versionEntries = {};
  }
}

type LoadPreAggregationResult = {
  targetTableName: string;
  refreshKeyValues: any[];
  lastUpdatedAt: number;
  buildRangeEnd?: string;
  lambdaTable?: InlineTable;
};

export class PreAggregationLoader {
  // eslint-disable-next-line no-use-before-define
  private preAggregations: PreAggregations;

  private preAggregation: any;

  private preAggregationsTablesToTempTables: any;

  private loadCache: any;

  private waitForRenew: boolean;

  private forceBuild: boolean;

  private orphanedTimeout: number;

  private externalDriverFactory: DriverFactory;

  private requestId: string;

  private metadata: any;

  private structureVersionPersistTime: any;

  private externalRefresh: boolean;

  public constructor(
    private readonly redisPrefix: string,
    private readonly driverFactory: DriverFactory,
    private readonly logger: any,
    private readonly queryCache: QueryCache,
    // eslint-disable-next-line no-use-before-define
    preAggregations: PreAggregations,
    preAggregation,
    preAggregationsTablesToTempTables,
    loadCache,
    options: any = {}
  ) {
    this.preAggregations = preAggregations;
    this.preAggregation = preAggregation;
    this.preAggregationsTablesToTempTables = preAggregationsTablesToTempTables;
    this.loadCache = loadCache;
    this.waitForRenew = options.waitForRenew;
    this.forceBuild = options.forceBuild;
    this.orphanedTimeout = options.orphanedTimeout;
    this.externalDriverFactory = preAggregations.externalDriverFactory;
    this.requestId = options.requestId;
    this.metadata = options.metadata;
    this.structureVersionPersistTime = preAggregations.structureVersionPersistTime;
    this.externalRefresh = options.externalRefresh;

    if (this.externalRefresh && this.waitForRenew) {
      const message = 'Invalid configuration - when externalRefresh is true, it will not perform a renew, therefore you cannot wait for it using waitForRenew.';
      if (['production', 'test'].includes(getEnv('nodeEnv'))) {
        throw new Error(message);
      } else {
        this.logger('Invalid Configuration', {
          requestId: this.requestId,
          warning: message,
        });
        this.waitForRenew = false;
      }
    }
  }

  public async loadPreAggregation(
    throwOnMissingPartition: boolean,
  ): Promise<null | LoadPreAggregationResult> {
    const notLoadedKey = (this.preAggregation.invalidateKeyQueries || [])
      .find(keyQuery => !this.loadCache.hasKeyQueryResult(keyQuery));
    if (notLoadedKey && !this.waitForRenew) {
      const structureVersion = getStructureVersion(this.preAggregation);

      const getVersionsStarted = new Date();
      const { byStructure } = await this.loadCache.getVersionEntries(this.preAggregation);
      this.logger('Load PreAggregations Tables', {
        preAggregation: this.preAggregation,
        requestId: this.requestId,
        duration: (new Date().getTime() - getVersionsStarted.getTime())
      });

      const versionEntryByStructureVersion = byStructure[`${this.preAggregation.tableName}_${structureVersion}`];
      if (this.externalRefresh) {
        if (!versionEntryByStructureVersion && throwOnMissingPartition) {
          throw new Error(
            'Your configuration restricts query requests to only be served from ' +
            'pre-aggregations, and required pre-aggregation partitions were not ' +
            'built yet. Please make sure your refresh worker is configured ' +
            'correctly and running.'
          );
        }
        if (!versionEntryByStructureVersion) {
          return null;
        } else {
          // the rollups are being maintained independently of this instance of cube.js
          // immediately return the latest rollup data that instance already has
          return {
            targetTableName: this.targetTableName(versionEntryByStructureVersion),
            lastUpdatedAt: versionEntryByStructureVersion.last_updated_at,
            refreshKeyValues: [],
          };
        }
      }

      if (versionEntryByStructureVersion) {
        // this triggers an asyncronous/background load of the pre-aggregation but immediately
        // returns the latest data it already has
        this.loadPreAggregationWithKeys().catch(e => {
          if (!(e instanceof ContinueWaitError)) {
            this.logger('Error loading pre-aggregation', {
              error: (e.stack || e),
              preAggregation: this.preAggregation,
              requestId: this.requestId
            });
          }
        });
        return {
          targetTableName: this.targetTableName(versionEntryByStructureVersion),
          refreshKeyValues: [],
          lastUpdatedAt: versionEntryByStructureVersion.last_updated_at,
          buildRangeEnd: versionEntryByStructureVersion.build_range_end,
        };
      } else {
        // no rollup has been built yet - build it synchronously as part of responding to this request
        return this.loadPreAggregationWithKeys();
      }
    } else {
      // either we have no data cached for this rollup or waitForRenew is true, either way,
      // synchronously renew what data is needed so that the most current data will be returned for the current request
      const result = await this.loadPreAggregationWithKeys();
      return {
        ...result,
        refreshKeyValues: await this.getInvalidationKeyValues()
      };
    }
  }

  protected async loadPreAggregationWithKeys(): Promise<LoadPreAggregationResult> {
    const invalidationKeys = await this.getInvalidationKeyValues();
    const contentVersion = this.contentVersion(invalidationKeys);
    const structureVersion = getStructureVersion(this.preAggregation);

    const versionEntries = await this.loadCache.getVersionEntries(this.preAggregation);

    const getVersionEntryByContentVersion = ({ byContent }: VersionEntriesObj) => byContent[`${this.preAggregation.tableName}_${contentVersion}`];

    const versionEntryByContentVersion = getVersionEntryByContentVersion(versionEntries);
    if (versionEntryByContentVersion && !this.forceBuild) {
      return {
        targetTableName: this.targetTableName(versionEntryByContentVersion),
        refreshKeyValues: [],
        lastUpdatedAt: versionEntryByContentVersion.last_updated_at,
        buildRangeEnd: versionEntryByContentVersion.build_range_end,
      };
    }

    // TODO this check can be redundant due to structure version is already checked in loadPreAggregation()
    if (
      !this.waitForRenew &&
      // eslint-disable-next-line no-use-before-define
      await this.loadCache.getQueryStage(PreAggregations.preAggregationQueryCacheKey(this.preAggregation))
    ) {
      const versionEntryByStructureVersion = versionEntries.byStructure[`${this.preAggregation.tableName}_${structureVersion}`];
      if (versionEntryByStructureVersion) {
        return {
          targetTableName: this.targetTableName(versionEntryByStructureVersion),
          refreshKeyValues: [],
          lastUpdatedAt: versionEntryByStructureVersion.last_updated_at,
          buildRangeEnd: versionEntryByStructureVersion.build_range_end,
        };
      }
    }

    const client = this.preAggregation.external ?
      await this.externalDriverFactory() :
      await this.driverFactory();

    if (!versionEntries.versionEntries.length) {
      await client.createSchemaIfNotExists(this.preAggregation.preAggregationsSchema);
    }

    // ensure we find appropriate structure version before invalidating anything
    const versionEntry =
      versionEntries.byStructure[`${this.preAggregation.tableName}_${structureVersion}`] ||
      versionEntries.byTableName[this.preAggregation.tableName];

    const newVersionEntry = {
      table_name: this.preAggregation.tableName,
      structure_version: structureVersion,
      content_version: contentVersion,
      last_updated_at: nowTimestamp(client),
      naming_version: 2,
    };

    const mostRecentResult: () => Promise<LoadPreAggregationResult> = async () => {
      await this.loadCache.reset(this.preAggregation);
      const lastVersion = getVersionEntryByContentVersion(
        await this.loadCache.getVersionEntries(this.preAggregation)
      );
      if (!lastVersion) {
        throw new Error(`Pre-aggregation table is not found for ${this.preAggregation.tableName} after it was successfully created`);
      }
      return {
        targetTableName: this.targetTableName(lastVersion),
        refreshKeyValues: [],
        lastUpdatedAt: lastVersion.last_updated_at,
        buildRangeEnd: lastVersion.build_range_end,
      };
    };

    if (this.forceBuild) {
      this.logger('Force build pre-aggregation', {
        preAggregation: this.preAggregation,
        requestId: this.requestId,
        metadata: this.metadata,
        queryKey: this.preAggregationQueryKey(invalidationKeys),
        newVersionEntry
      });
      await this.executeInQueue(invalidationKeys, this.priority(10), newVersionEntry);
      return mostRecentResult();
    }

    if (versionEntry) {
      if (versionEntry.structure_version !== newVersionEntry.structure_version) {
        this.logger('Invalidating pre-aggregation structure', {
          preAggregation: this.preAggregation,
          requestId: this.requestId,
          queryKey: this.preAggregationQueryKey(invalidationKeys),
          newVersionEntry
        });
        await this.executeInQueue(invalidationKeys, this.priority(10), newVersionEntry);
        return mostRecentResult();
      } else if (versionEntry.content_version !== newVersionEntry.content_version) {
        if (this.waitForRenew) {
          this.logger('Waiting for pre-aggregation renew', {
            preAggregation: this.preAggregation,
            requestId: this.requestId,
            queryKey: this.preAggregationQueryKey(invalidationKeys),
            newVersionEntry
          });
          await this.executeInQueue(invalidationKeys, this.priority(0), newVersionEntry);
          return mostRecentResult();
        } else {
          this.scheduleRefresh(invalidationKeys, newVersionEntry);
        }
      }
    } else {
      this.logger('Creating pre-aggregation from scratch', {
        preAggregation: this.preAggregation,
        requestId: this.requestId,
        queryKey: this.preAggregationQueryKey(invalidationKeys),
        newVersionEntry
      });
      await this.executeInQueue(invalidationKeys, this.priority(10), newVersionEntry);
      return mostRecentResult();
    }
    return {
      targetTableName: this.targetTableName(versionEntry),
      refreshKeyValues: [],
      lastUpdatedAt: versionEntry.last_updated_at,
      buildRangeEnd: versionEntry.build_range_end,
    };
  }

  protected contentVersion(invalidationKeys) {
    return version(
      this.preAggregation.indexesSql && this.preAggregation.indexesSql.length ?
        [this.preAggregation.loadSql, this.preAggregation.indexesSql, invalidationKeys] :
        [this.preAggregation.loadSql, invalidationKeys]
    );
  }

  protected priority(defaultValue) {
    return this.preAggregation.priority != null ? this.preAggregation.priority : defaultValue;
  }

  protected getInvalidationKeyValues() {
    return Promise.all(
      (this.preAggregation.invalidateKeyQueries || []).map(
        (sqlQuery) => this.loadCache.keyQueryResult(sqlQuery, this.waitForRenew, this.priority(10))
      )
    );
  }

  protected scheduleRefresh(invalidationKeys, newVersionEntry) {
    this.logger('Refreshing pre-aggregation content', {
      preAggregation: this.preAggregation,
      requestId: this.requestId,
      queryKey: this.preAggregationQueryKey(invalidationKeys),
      newVersionEntry
    });
    this.executeInQueue(invalidationKeys, this.priority(0), newVersionEntry)
      .catch(e => {
        if (!(e instanceof ContinueWaitError)) {
          this.logger('Error refreshing pre-aggregation', {
            error: (e.stack || e), preAggregation: this.preAggregation, requestId: this.requestId
          });
        }
      });
  }

  protected async executeInQueue(invalidationKeys, priority, newVersionEntry) {
    const query = await this.preAggregations.getQueue(this.preAggregation.dataSource);
    return query.executeInQueue(
      'query',
      this.preAggregationQueryKey(invalidationKeys),
      {
        preAggregation: this.preAggregation,
        preAggregationsTablesToTempTables: this.preAggregationsTablesToTempTables,
        newVersionEntry,
        requestId: this.requestId,
        invalidationKeys,
        forceBuild: this.forceBuild,
        metadata: this.metadata,
        orphanedTimeout: this.orphanedTimeout,
      },
      priority,
      // eslint-disable-next-line no-use-before-define
      { stageQueryKey: PreAggregations.preAggregationQueryCacheKey(this.preAggregation), requestId: this.requestId }
    );
  }

  protected preAggregationQueryKey(invalidationKeys) {
    return this.preAggregation.indexesSql && this.preAggregation.indexesSql.length ?
      [this.preAggregation.loadSql, this.preAggregation.indexesSql, invalidationKeys] :
      [this.preAggregation.loadSql, invalidationKeys];
  }

  protected targetTableName(versionEntry): string {
    // eslint-disable-next-line no-use-before-define
    return PreAggregations.targetTableName(versionEntry);
  }

  public refresh(newVersionEntry, invalidationKeys, client) {
    let refreshStrategy = this.refreshImplStoreInSourceStrategy;
    if (this.preAggregation.external) {
      const readOnly =
        this.preAggregation.readOnly ||
        client.config && client.config.readOnly ||
        client.readOnly && (typeof client.readOnly === 'boolean' ? client.readOnly : client.readOnly());
      refreshStrategy = readOnly ?
        this.refreshImplStreamExternalStrategy : this.refreshImplTempTableExternalStrategy;
    }
    return cancelCombinator(
      saveCancelFn => refreshStrategy.bind(this)(
        client,
        newVersionEntry,
        saveCancelFn,
        invalidationKeys
      )
    );
  }

  protected logExecutingSql(payload) {
    this.logger(
      'Executing Load Pre Aggregation SQL',
      payload
    );
  }

  protected queryOptions(invalidationKeys, query, params, targetTableName, newVersionEntry) {
    return {
      queryKey: this.preAggregationQueryKey(invalidationKeys),
      query,
      values: params,
      targetTableName,
      requestId: this.requestId,
      newVersionEntry,
      buildRangeEnd: this.preAggregation.buildRangeEnd,
    };
  }

  protected async refreshImplStoreInSourceStrategy(
    client: DriverInterface,
    newVersionEntry,
    saveCancelFn: SaveCancelFn,
    invalidationKeys
  ) {
    const [loadSql, params] =
        Array.isArray(this.preAggregation.loadSql) ? this.preAggregation.loadSql : [this.preAggregation.loadSql, []];
    const targetTableName = this.targetTableName(newVersionEntry);
    const query = QueryCache.replacePreAggregationTableNames(loadSql, this.preAggregationsTablesToTempTables)
      .replace(
        this.preAggregation.tableName,
        targetTableName
      );
    const queryOptions = this.queryOptions(invalidationKeys, query, params, targetTableName, newVersionEntry);
    this.logExecutingSql(queryOptions);

    try {
      // TODO move index creation to the driver
      await saveCancelFn(client.loadPreAggregationIntoTable(
        targetTableName,
        query,
        params,
        queryOptions
      ));

      await this.createIndexes(client, newVersionEntry, saveCancelFn, queryOptions);
      await this.loadCache.fetchTables(this.preAggregation);
    } finally {
      // We must clean orphaned in any cases: success or exception
      await this.dropOrphanedTables(client, targetTableName, saveCancelFn, false, queryOptions);
      await this.loadCache.fetchTables(this.preAggregation);
    }
  }

  /**
   * Strategy to copy pre-aggregation from source db (with write permissions) to external data
   */
  protected async refreshImplTempTableExternalStrategy(
    client: DriverInterface,
    newVersionEntry: VersionEntry,
    saveCancelFn: SaveCancelFn,
    invalidationKeys
  ) {
    const [loadSql, params] =
        Array.isArray(this.preAggregation.loadSql) ? this.preAggregation.loadSql : [this.preAggregation.loadSql, []];
    await client.createSchemaIfNotExists(this.preAggregation.preAggregationsSchema);
    const targetTableName = this.targetTableName(newVersionEntry);
    const query = QueryCache.replacePreAggregationTableNames(loadSql, this.preAggregationsTablesToTempTables)
      .replace(
        this.preAggregation.tableName,
        targetTableName
      );
    const queryOptions = this.queryOptions(invalidationKeys, query, params, targetTableName, newVersionEntry);
    this.logExecutingSql(queryOptions);
    await saveCancelFn(client.loadPreAggregationIntoTable(
      targetTableName,
      query,
      params,
      queryOptions
    ));

    try {
      const tableData = await this.downloadTempExternalPreAggregation(
        client,
        newVersionEntry,
        saveCancelFn,
        queryOptions
      );

      try {
        await this.uploadExternalPreAggregation(tableData, newVersionEntry, saveCancelFn, queryOptions);
      } finally {
        if (tableData && tableData.release) {
          await tableData.release();
        }
      }
    } finally {
      const actualTables = await client.getTablesQuery(this.preAggregation.preAggregationsSchema);
      const mappedActualTables = actualTables.map(t => `${this.preAggregation.preAggregationsSchema}.${t.table_name || t.TABLE_NAME}`);
      if (mappedActualTables.includes(targetTableName)) {
        await client.dropTable(targetTableName);
      }
      // We must clean orphaned in any cases: success or exception
      await this.loadCache.fetchTables(this.preAggregation);
      await this.dropOrphanedTables(client, targetTableName, saveCancelFn, false, queryOptions);
    }
  }

  /**
   * Strategy to copy pre-aggregation from source db (for read-only permissions) to external data
   */
  protected async refreshImplStreamExternalStrategy(
    client: DriverInterface,
    newVersionEntry: VersionEntry,
    saveCancelFn,
    invalidationKeys
  ) {
    const [sql, params] =
        Array.isArray(this.preAggregation.sql) ? this.preAggregation.sql : [this.preAggregation.sql, []];

    // @todo Deprecated, BaseDriver already implements it, before remove we need to add check for factoryDriver
    if (!client.downloadQueryResults) {
      throw new Error('Can\'t load external pre-aggregation: source driver doesn\'t support downloadQueryResults()');
    }

    const queryOptions = this.queryOptions(invalidationKeys, sql, params, this.targetTableName(newVersionEntry), newVersionEntry);
    this.logExecutingSql(queryOptions);
    this.logger('Downloading external pre-aggregation via query', queryOptions);
    const externalDriver = await this.externalDriverFactory();
    const capabilities = externalDriver.capabilities && externalDriver.capabilities();

    const tableData = await saveCancelFn(client.downloadQueryResults(
      sql,
      params, {
        ...queryOptions,
        ...capabilities,
        ...this.getStreamingOptions(),
      }
    )).catch((error: any) => {
      this.logger('Downloading external pre-aggregation via query error', { ...queryOptions, error: error.stack || error.message });
      throw error;
    });
    this.logger('Downloading external pre-aggregation via query completed', queryOptions);

    try {
      await this.uploadExternalPreAggregation(tableData, newVersionEntry, saveCancelFn, queryOptions);
    } finally {
      if (tableData.release) {
        await tableData.release();
      }
    }

    await this.loadCache.fetchTables(this.preAggregation);
  }

  protected getUnloadOptions(): UnloadOptions {
    return {
      // Default: 16mb for Snowflake, Should be specified in MBs, because drivers convert it
      maxFileSize: 64
    };
  }

  protected getStreamingOptions(): StreamOptions {
    return {
      // Default: 16384 (16KB), or 16 for objectMode streams. PostgreSQL/MySQL use object streams
      highWaterMark: 10000
    };
  }

  /**
   * Create table (for db with write permissions) and extract data via memory/stream/unload
   */
  protected async downloadTempExternalPreAggregation(
    client: DriverInterface,
    newVersionEntry,
    saveCancelFn: SaveCancelFn,
    queryOptions: any
  ) {
    // @todo Deprecated, BaseDriver already implements it, before remove we need to add check for factoryDriver
    if (!client.downloadTable) {
      throw new Error('Can\'t load external pre-aggregation: source driver doesn\'t support downloadTable()');
    }

    const table = this.targetTableName(newVersionEntry);
    this.logger('Downloading external pre-aggregation', queryOptions);

    try {
      const externalDriver = await this.externalDriverFactory();
      // TODO: Drop any, awaiting https://github.com/cube-js/cube.js/pull/5233
      const capabilities: any = externalDriver.capabilities && externalDriver.capabilities();

      let tableData: DownloadTableData;

      if (capabilities.csvImport && client.unload && await client.isUnloadSupported(this.getUnloadOptions())) {
        tableData = await saveCancelFn(client.unload(table, this.getUnloadOptions()));
      } else if (capabilities.streamImport && client.stream) {
        tableData = await saveCancelFn(
          client.stream(`SELECT * FROM ${table}`, [], this.getStreamingOptions())
        );

        if (client.unload) {
          const stream = new LargeStreamWarning(this.preAggregation.preAggregationId, (msg) => {
            this.logger('Downloading external pre-aggregation warning', {
              ...queryOptions,
              error: msg
            });
          });
          tableData.rowStream.pipe(stream);
          tableData.rowStream = stream;
        }
      } else {
        tableData = await saveCancelFn(client.downloadTable(table, capabilities));
      }

      if (!tableData.types) {
        tableData.types = await saveCancelFn(client.tableColumnTypes(table));
      }
      this.logger('Downloading external pre-aggregation completed', queryOptions);

      return tableData;
    } catch (error: any) {
      this.logger('Downloading external pre-aggregation error', {
        ...queryOptions,
        error: error?.stack || error?.message
      });
      throw error;
    }
  }

  protected async uploadExternalPreAggregation(
    tableData: DownloadTableData,
    newVersionEntry: VersionEntry,
    saveCancelFn: SaveCancelFn,
    queryOptions: any
  ) {
    const externalDriver: DriverInterface = await this.externalDriverFactory();
    const table = this.targetTableName(newVersionEntry);

    this.logger('Uploading external pre-aggregation', queryOptions);
    await saveCancelFn(
      externalDriver.uploadTableWithIndexes(
        table,
        tableData.types,
        tableData,
        this.prepareIndexesSql(newVersionEntry, queryOptions),
        this.preAggregation.uniqueKeyColumns,
        queryOptions,
        this.preAggregation.aggregationsColumns,
        this.prepareCreateTableIndexes(newVersionEntry, queryOptions),
      )
    ).catch((error: any) => {
      this.logger('Uploading external pre-aggregation error', { ...queryOptions, error: error?.stack || error?.message });
      throw error;
    });
    this.logger('Uploading external pre-aggregation completed', queryOptions);

    await this.loadCache.fetchTables(this.preAggregation);
    await this.dropOrphanedTables(externalDriver, table, saveCancelFn, true, queryOptions);
  }

  protected async createIndexes(driver, newVersionEntry, saveCancelFn, queryOptions) {
    const indexesSql = this.prepareIndexesSql(newVersionEntry, queryOptions);
    for (let i = 0; i < indexesSql.length; i++) {
      const [query, params] = indexesSql[i].sql;
      await saveCancelFn(driver.query(query, params));
    }
  }

  protected prepareIndexesSql(newVersionEntry, queryOptions) {
    if (!this.preAggregation.indexesSql || !this.preAggregation.indexesSql.length) {
      return [];
    }
    return this.preAggregation.indexesSql.map(({ sql, indexName }) => {
      const [query, params] = sql;
      const indexVersionEntry = {
        ...newVersionEntry,
        table_name: indexName
      };
      this.logger('Creating pre-aggregation index', queryOptions);
      const resultingSql = QueryCache.replacePreAggregationTableNames(
        query,
        this.preAggregationsTablesToTempTables.concat([
          [this.preAggregation.tableName, { targetTableName: this.targetTableName(newVersionEntry) }],
          [indexName, { targetTableName: this.targetTableName(indexVersionEntry) }]
        ])
      );
      return { sql: [resultingSql, params] };
    });
  }

  protected prepareCreateTableIndexes(newVersionEntry, queryOptions) {
    if (!this.preAggregation.createTableIndexes || !this.preAggregation.createTableIndexes.length) {
      return [];
    }
    return this.preAggregation.createTableIndexes.map(({ indexName, type, columns }) => {
      const indexVersionEntry = {
        ...newVersionEntry,
        table_name: indexName
      };
      return { indexName: this.targetTableName(indexVersionEntry), type, columns };
    });
  }

  protected async dropOrphanedTables(
    client: DriverInterface,
    justCreatedTable: string,
    saveCancelFn: SaveCancelFn,
    external: boolean,
    queryOptions: any
  ) {
    await this.preAggregations.addTableUsed(justCreatedTable);

    const lockKey = external
      ? 'drop-orphaned-tables-external'
      : `drop-orphaned-tables:${this.preAggregation.dataSource}`;

    return this.queryCache.withLock(lockKey, 60 * 5, async () => {
      this.logger('Dropping orphaned tables', queryOptions);
      const actualTables = await client.getTablesQuery(this.preAggregation.preAggregationsSchema);
      const versionEntries = tablesToVersionEntries(this.preAggregation.preAggregationsSchema, actualTables);
      const versionEntriesToSave = R.pipe<
        VersionEntry[],
        { [index: string]: VersionEntry[] },
        Array<[string, VersionEntry[]]>,
        VersionEntry[]
        >(
          R.groupBy(v => v.table_name),
          R.toPairs,
          R.map(p => p[1][0])
        )(versionEntries);

      const structureVersionsToSave = R.pipe<
        VersionEntry[],
        VersionEntry[],
        { [index: string]: VersionEntry[] },
        Array<[string, VersionEntry[]]>,
        VersionEntry[]
        >(
          R.filter(
            (v: VersionEntry) => new Date().getTime() - v.last_updated_at < this.structureVersionPersistTime * 1000
          ),
          R.groupBy(v => `${v.table_name}_${v.structure_version}`),
          R.toPairs,
          R.map(p => p[1][0])
        )(versionEntries);

      const tablesToSave =
        (await this.preAggregations.tablesUsed())
          .concat(structureVersionsToSave.map(v => this.targetTableName(v)))
          .concat(versionEntriesToSave.map(v => this.targetTableName(v)))
          .concat([justCreatedTable]);

      const toDrop = actualTables
        .map(t => `${this.preAggregation.preAggregationsSchema}.${t.table_name || t.TABLE_NAME}`)
        .filter(t => tablesToSave.indexOf(t) === -1);

      await Promise.all(toDrop.map(table => saveCancelFn(client.dropTable(table))));
      this.logger('Dropping orphaned tables completed', {
        ...queryOptions,
        tablesToDrop: JSON.stringify(toDrop),
      });
    });
  }
}

interface PreAggsPartiotionRangeLoaderOpts {
  maxPartitions: number;
  maxSourceRowLimit: number;
  waitForRenew?: boolean;
  requestId?: string;
  externalRefresh?: boolean;
  forceBuild?: boolean;
  metadata?: any;
  orphanedTimeout?: number;
  lambdaQuery?: LambdaQuery;
}

export class PreAggregationPartitionRangeLoader {
  protected waitForRenew: boolean;

  protected requestId: string;

  protected lambdaQuery: LambdaQuery;

  protected dataSource: string;

  public constructor(
    private readonly redisPrefix: string,
    private readonly driverFactory: DriverFactory,
    private readonly logger: any,
    private readonly queryCache: QueryCache,
    // eslint-disable-next-line no-use-before-define
    private readonly preAggregations: PreAggregations,
    private readonly preAggregation: PreAggregationDescription,
    private readonly preAggregationsTablesToTempTables: any,
    private readonly loadCache: any,
    private readonly options: PreAggsPartiotionRangeLoaderOpts = {
      maxPartitions: 10000,
      maxSourceRowLimit: 10000,
    },
  ) {
    this.waitForRenew = options.waitForRenew;
    this.requestId = options.requestId;
    this.lambdaQuery = options.lambdaQuery;
    this.dataSource = preAggregation.dataSource;
  }

  private async loadRangeQuery(rangeQuery: QueryTuple, partitionRange?: QueryDateRange) {
    const [query, values, queryOptions]: QueryTuple = rangeQuery;
    const invalidate =
      this.preAggregation.invalidateKeyQueries &&
      this.preAggregation.invalidateKeyQueries[0]
        ? this.preAggregation.invalidateKeyQueries[0].slice(0, 2)
        : false;

    return this.queryCache.cacheQueryResult(
      query,
      values,
      QueryCache.queryCacheKey({ query, values, invalidate }),
      24 * 60 * 60,
      {
        renewalThreshold: this.queryCache.options.refreshKeyRenewalThreshold
          || queryOptions?.renewalThreshold || 24 * 60 * 60,
        waitForRenew: this.waitForRenew,
        priority: this.priority(10),
        requestId: this.requestId,
        dataSource: this.dataSource,
        useInMemory: true,
        external: queryOptions?.external,
        renewalKey: partitionRange ? await this.getInvalidationKeyValues(partitionRange) : null,
      }
    );
  }

  protected getInvalidationKeyValues(range) {
    const partitionTableName = PreAggregationPartitionRangeLoader.partitionTableName(
      this.preAggregation.tableName, this.preAggregation.partitionGranularity, range
    );
    return Promise.all(
      (this.preAggregation.invalidateKeyQueries || []).map(
        (sqlQuery) => (
          this.loadCache.keyQueryResult(
            this.replacePartitionSqlAndParams(sqlQuery, range, partitionTableName), this.waitForRenew, this.priority(10)
          )
        )
      )
    );
  }

  protected priority(defaultValue) {
    return this.preAggregation.priority != null ? this.preAggregation.priority : defaultValue;
  }

  public async replaceQueryBuildRangeParams(queryValues: string[]): Promise<string[] | null> {
    if (queryValues?.find(p => p === BUILD_RANGE_START_LOCAL || p === BUILD_RANGE_END_LOCAL)) {
      const [buildRangeStart, buildRangeEnd] = await this.loadBuildRange();
      return queryValues?.map(
        param => {
          if (param === BUILD_RANGE_START_LOCAL) {
            return utcToLocalTimeZone(this.preAggregation.timezone, this.preAggregation.timestampFormat, buildRangeStart);
          } else if (param === BUILD_RANGE_END_LOCAL) {
            return utcToLocalTimeZone(this.preAggregation.timezone, this.preAggregation.timestampFormat, buildRangeEnd);
          } else {
            return param;
          }
        },
      );
    }
    return null;
  }

  private replacePartitionSqlAndParams(
    query: QueryWithParams,
    dateRange: QueryDateRange,
    partitionTableName: string
  ): QueryWithParams {
    const [sql, params, options] = query;
    const updateWindowToBoundary = options?.incremental && addSecondsToLocalTimestamp(
      dateRange[1], this.preAggregation.timezone, options?.updateWindowSeconds || 0
    );
    return [sql.replace(this.preAggregation.tableName, partitionTableName), params?.map(
      param => {
        if (dateRange && param === FROM_PARTITION_RANGE) {
          return PreAggregationPartitionRangeLoader.inDbTimeZone(this.preAggregation, dateRange[0]);
        } else if (dateRange && param === TO_PARTITION_RANGE) {
          return PreAggregationPartitionRangeLoader.inDbTimeZone(this.preAggregation, dateRange[1]);
        } else {
          return param;
        }
      },
    ), {
      ...options,
      renewalThreshold:
        options?.incremental && updateWindowToBoundary < new Date() ?
          // if updateWindowToBoundary passed just moments ago we want to renew it earlier in case
          // of server and db clock don't match
          Math.min(
            Math.round((new Date().getTime() - updateWindowToBoundary.getTime()) / 1000),
            options?.renewalThresholdOutsideUpdateWindow
          ) :
          options?.renewalThreshold
    }];
  }

  private partitionPreAggregationDescription(range: QueryDateRange, buildRange: QueryDateRange): PreAggregationDescription {
    const partitionTableName = PreAggregationPartitionRangeLoader.partitionTableName(
      this.preAggregation.tableName, this.preAggregation.partitionGranularity, range
    );
    const [_, buildRangeEnd] = buildRange;
    const loadRange: [string, string] = [...range];
    if (this.preAggregation.unionWithSourceData && buildRangeEnd < range[1]) {
      loadRange[1] = buildRangeEnd;
    }

    return {
      ...this.preAggregation,
      tableName: partitionTableName,
      loadSql: this.preAggregation.loadSql &&
        this.replacePartitionSqlAndParams(this.preAggregation.loadSql, loadRange, partitionTableName),
      sql: this.preAggregation.sql &&
        this.replacePartitionSqlAndParams(this.preAggregation.sql, loadRange, partitionTableName),
      invalidateKeyQueries: (this.preAggregation.invalidateKeyQueries || [])
        .map(q => this.replacePartitionSqlAndParams(q, range, partitionTableName)),
      indexesSql: (this.preAggregation.indexesSql || [])
        .map(q => ({ ...q, sql: this.replacePartitionSqlAndParams(q.sql, range, partitionTableName) })),
      previewSql: this.preAggregation.previewSql &&
        this.replacePartitionSqlAndParams(this.preAggregation.previewSql, range, partitionTableName),
      buildRangeEnd,
    };
  }

  public async loadPreAggregations(): Promise<LoadPreAggregationResult> {
    if (this.preAggregation.partitionGranularity && !this.preAggregation.expandedPartition) {
      const { buildRange, partitionRanges } = await this.partitionRanges();
      const partitionLoaders = partitionRanges.map(range => new PreAggregationLoader(
        this.redisPrefix,
        this.driverFactory,
        this.logger,
        this.queryCache,
        this.preAggregations,
        this.partitionPreAggregationDescription(range, buildRange),
        this.preAggregationsTablesToTempTables,
        this.loadCache,
        this.options,
      ));
      const resolveResults = await Promise.all(partitionLoaders.map(l => l.loadPreAggregation(false)));
      const loadResults = resolveResults.filter(res => res !== null);
      if (this.options.externalRefresh && loadResults.length === 0) {
        throw new Error(
          'No pre-aggregation partitions were built yet for the pre-aggregation serving this query. ' +
          'Please ensure your refresh worker is configured correctly, running, and has already built this pre-aggregation.'
        );
      }
      const allTableTargetNames = loadResults.map(targetTableName => targetTableName.targetTableName);
      let lastUpdatedAt = getLastUpdatedAtTimestamp(loadResults.map(r => r.lastUpdatedAt));
      let lambdaTable: InlineTable;

      if (this.lambdaQuery && loadResults.length > 0) {
        const { buildRangeEnd } = loadResults[loadResults.length - 1];
        lambdaTable = await this.downloadLambdaTable(buildRangeEnd);
        allTableTargetNames.push(lambdaTable.name);
        lastUpdatedAt = Date.now();
      }

      const unionTargetTableName = allTableTargetNames
        .map(targetTableName => `SELECT * FROM ${targetTableName}`)
        .join(' UNION ALL ');
      return {
        targetTableName: allTableTargetNames.length === 1 ? allTableTargetNames[0] : `(${unionTargetTableName})`,
        refreshKeyValues: loadResults.map(t => t.refreshKeyValues),
        lastUpdatedAt,
        buildRangeEnd: undefined,
        lambdaTable,
      };
    } else {
      return new PreAggregationLoader(
        this.redisPrefix,
        this.driverFactory,
        this.logger,
        this.queryCache,
        this.preAggregations,
        this.preAggregation,
        this.preAggregationsTablesToTempTables,
        this.loadCache,
        this.options
      ).loadPreAggregation(true);
    }
  }

  /**
   * Downloads the lambda table from the source DB.
   */
  private async downloadLambdaTable(fromDate: string): Promise<InlineTable> {
    const { sqlAndParams, cacheKeyQueries } = this.lambdaQuery;
    const [query, params] = sqlAndParams;
    const values = params.map((p) => {
      if (p === FROM_PARTITION_RANGE) {
        return fromDate;
      }
      if (p === MAX_SOURCE_ROW_LIMIT) {
        return this.options.maxSourceRowLimit;
      }
      return p;
    });
    const { data } = await this.queryCache.renewQuery(
      query,
      values,
      cacheKeyQueries,
      60 * 60,
      [query, values],
      undefined,
      {
        requestId: this.requestId,
        skipRefreshKeyWaitForRenew: false,
        dataSource: this.dataSource,
        external: false,
        useCsvQuery: true,
      }
    );
    if (data.rowCount === this.options.maxSourceRowLimit) {
      throw new Error(`The maximum number of source rows ${this.options.maxSourceRowLimit} was reached for ${this.preAggregation.preAggregationId}`);
    }
    return {
      name: `${LAMBDA_TABLE_PREFIX}_${this.preAggregation.tableName.replace('.', '_')}`,
      columns: data.types,
      csvRows: data.csvRows,
    };
  }

  public async partitionPreAggregations(): Promise<PreAggregationDescription[]> {
    if (this.preAggregation.partitionGranularity && !this.preAggregation.expandedPartition) {
      const { buildRange, partitionRanges } = await this.partitionRanges();
      return partitionRanges.map(range => this.partitionPreAggregationDescription(range, buildRange));
    } else {
      return [this.preAggregation];
    }
  }

  private async partitionRanges(): Promise<PartitionRanges> {
    const buildRange = await this.loadBuildRange();
    if (!buildRange[0] || !buildRange[1]) {
      return { buildRange, partitionRanges: [] };
    }
    let dateRange = PreAggregationPartitionRangeLoader.intersectDateRanges(
      buildRange,
      this.preAggregation.matchedTimeDimensionDateRange,
    );
    if (!dateRange) {
      // If there's no date range intersection between query data range and pre-aggregation build range
      // use last partition so outer query can receive expected table structure.
      dateRange = [buildRange[1], buildRange[1]];
    }
    const partitionRanges = PreAggregationPartitionRangeLoader.timeSeries(
      this.preAggregation.partitionGranularity,
      dateRange,
    );
    if (partitionRanges.length > this.options.maxPartitions) {
      throw new Error(
        `The maximum number of partitions (${
          this.options.maxPartitions
        }) was reached for the pre-aggregation`
      );
    }
    return { buildRange: dateRange, partitionRanges };
  }

  public async loadBuildRange(): Promise<QueryDateRange> {
    const { preAggregationStartEndQueries } = this.preAggregation;
    const [startDate, endDate] = await Promise.all(
      preAggregationStartEndQueries.map(
        async rangeQuery => PreAggregationPartitionRangeLoader.extractDate(await this.loadRangeQuery(rangeQuery)),
      ),
    );
    if (!this.preAggregation.partitionGranularity) {
      return this.orNowIfEmpty([startDate, endDate]);
    }
    const wholeSeriesRanges = PreAggregationPartitionRangeLoader.timeSeries(
      this.preAggregation.partitionGranularity,
      this.orNowIfEmpty([startDate, endDate]),
    );
    const [rangeStart, rangeEnd] = await Promise.all(
      preAggregationStartEndQueries.map(
        async (rangeQuery, i) => PreAggregationPartitionRangeLoader.extractDate(
          await this.loadRangeQuery(
            rangeQuery, i === 0 ? wholeSeriesRanges[0] : wholeSeriesRanges[wholeSeriesRanges.length - 1],
          ),
        ),
      ),
    );
    return this.orNowIfEmpty([rangeStart, rangeEnd]);
  }

  private now() {
    return utcToLocalTimeZone(this.preAggregation.timezone, 'YYYY-MM-DDTHH:mm:ss.SSS', new Date().toJSON().substring(0, 23));
  }

  private orNowIfEmpty(dateRange: QueryDateRange): QueryDateRange {
    if (!dateRange[0] && !dateRange[1]) {
      const now = this.now();
      return [now, now];
    }
    if (!dateRange[0]) {
      return [dateRange[1], dateRange[1]];
    }
    if (!dateRange[1]) {
      return [dateRange[0], dateRange[0]];
    }
    return dateRange;
  }

  private static checkDataRangeType(range: QueryDateRange) {
    if (!range) {
      return;
    }
    if (range.length !== 2) {
      throw new Error(`Date range expected to be an array with 2 elements but ${range} found`);
    }
    if (typeof range[0] !== 'string' || typeof range[1] !== 'string') {
      throw new Error(`Date range expected to be a string array but ${range} found`);
    }
    if (range[0].length !== 23 || range[1].length !== 23) {
      throw new Error(`Date range expected to be in YYYY-MM-DDTHH:mm:ss.SSS format but ${range} found`);
    }
  }

  public static intersectDateRanges(rangeA: QueryDateRange | null, rangeB: QueryDateRange | null): QueryDateRange {
    PreAggregationPartitionRangeLoader.checkDataRangeType(rangeA);
    PreAggregationPartitionRangeLoader.checkDataRangeType(rangeB);
    if (!rangeB) {
      return rangeA;
    }
    if (!rangeA) {
      return rangeB;
    }
    const from = rangeA[0] > rangeB[0] ? rangeA[0] : rangeB[0];
    const to = rangeA[1] < rangeB[1] ? rangeA[1] : rangeB[1];
    if (from > to) {
      return null;
    }
    return [
      from,
      to,
    ];
  }

  public static timeSeries(granularity: string, dateRange: QueryDateRange): QueryDateRange[] {
    return timeSeries(granularity, dateRange);
  }

  public static partitionTableName(tableName: string, partitionGranularity: string, dateRange: string[]) {
    const partitionSuffix = dateRange[0].substring(
      0,
      partitionGranularity === 'hour' ? 13 : 10
    ).replace(/[-T:]/g, '');
    return `${tableName}${partitionSuffix}`;
  }

  public static inDbTimeZone(preAggregationDescription: any, timestamp: string): string {
    return inDbTimeZone(preAggregationDescription.timezone, preAggregationDescription.timestampFormat, timestamp);
  }

  public static extractDate(data: any): string {
    return extractDate(data);
  }

  public static FROM_PARTITION_RANGE = FROM_PARTITION_RANGE;

  public static TO_PARTITION_RANGE = TO_PARTITION_RANGE;
}

type PreAggregationsOptions = {
  maxPartitions: number;
  maxSourceRowLimit: number;
  preAggregationsSchemaCacheExpire?: number;
  loadCacheQueueOptions?: any;
  queueOptions?: (dataSource: string) => Promise<{
    concurrency: number;
    continueWaitTimeout?: number;
    executionTimeout?: number;
    orphanedTimeout?: number;
    heartBeatInterval?: number;
  }>;
  redisPool?: any;
  continueWaitTimeout?: number;
  cacheAndQueueDriver?: 'redis' | 'memory';
  skipExternalCacheAndQueue?: boolean;
};

export class PreAggregations {
  public options: PreAggregationsOptions;

  private cacheDriver: CacheDriverInterface;

  public externalDriverFactory: any;

  public structureVersionPersistTime: any;

  private readonly usedTablePersistTime: number;

  private readonly externalRefresh: boolean;

  private readonly loadCacheQueue: Record<string, QueryQueue> = {};

  private readonly queue: Record<string, QueryQueue> = {};

  private readonly getQueueEventsBus: any;

  public constructor(
    private readonly redisPrefix: string,
    private readonly driverFactory: DriverFactoryByDataSource,
    private readonly logger: any,
    private readonly queryCache: QueryCache,
    options,
  ) {
    this.options = options || {};

    this.cacheDriver = options.cacheAndQueueDriver === 'redis' ?
      new RedisCacheDriver({ pool: options.redisPool }) :
      new LocalCacheDriver();

    this.externalDriverFactory = options.externalDriverFactory;
    this.structureVersionPersistTime = options.structureVersionPersistTime || 60 * 60 * 24 * 30;
    this.usedTablePersistTime = options.usedTablePersistTime || getEnv('dbQueryTimeout');
    this.externalRefresh = options.externalRefresh;
    this.getQueueEventsBus = options.getQueueEventsBus;
  }

  protected tablesUsedRedisKey(tableName) {
    // TODO add dataSource?
    return `SQL_PRE_AGGREGATIONS_${this.redisPrefix}_TABLES_USED_${tableName}`;
  }

  public async addTableUsed(tableName) {
    return this.cacheDriver.set(this.tablesUsedRedisKey(tableName), true, this.usedTablePersistTime);
  }

  public async tablesUsed() {
    return (await this.cacheDriver.keysStartingWith(this.tablesUsedRedisKey('')))
      .map(k => k.replace(this.tablesUsedRedisKey(''), ''));
  }

  public loadAllPreAggregationsIfNeeded(queryBody) {
    const preAggregations = queryBody.preAggregations || [];

    const loadCacheByDataSource = queryBody.preAggregationsLoadCacheByDataSource || {};

    const getLoadCacheByDataSource = (dataSource = 'default', preAggregationSchema) => {
      if (!loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`]) {
        loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`] =
          new PreAggregationLoadCache(
            this.redisPrefix,
            () => this.driverFactory(dataSource),
            this.queryCache,
            this,
            {
              requestId: queryBody.requestId,
              dataSource,
              tablePrefixes:
                // Can't reuse tablePrefixes for shared refresh scheduler cache
                !queryBody.preAggregationsLoadCacheByDataSource ?
                  preAggregations
                    .filter(p => (p.dataSource || 'default') === dataSource)
                    .map(p => p.tableName.split('.')[1]) : null
            }
          );
      }

      return loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`];
    };

    let queryParamsReplacement = null;

    const preAggregationsTablesToTempTablesPromise = preAggregations.map((p: PreAggregationDescription, i) => (preAggregationsTablesToTempTables) => {
      const loader = new PreAggregationPartitionRangeLoader(
        this.redisPrefix,
        () => this.driverFactory(p.dataSource || 'default'),
        this.logger,
        this.queryCache,
        this,
        p,
        preAggregationsTablesToTempTables,
        getLoadCacheByDataSource(p.dataSource, p.preAggregationsSchema),
        {
          maxPartitions: this.options.maxPartitions,
          maxSourceRowLimit: this.options.maxSourceRowLimit,
          waitForRenew: queryBody.renewQuery,
          // TODO workaround to avoid continuous waiting on building pre-aggregation dependencies
          forceBuild: i === preAggregations.length - 1 ? queryBody.forceBuildPreAggregations : false,
          requestId: queryBody.requestId,
          metadata: queryBody.metadata,
          orphanedTimeout: queryBody.orphanedTimeout,
          lambdaQuery: (queryBody.lambdaQueries ?? {})[p.preAggregationId],
          externalRefresh: this.externalRefresh
        },
      );

      const preAggregationPromise = async () => {
        const loadResult = await loader.loadPreAggregations();
        const usedPreAggregation = {
          ...loadResult,
          type: p.type,
        };
        await this.addTableUsed(usedPreAggregation.targetTableName);

        if (i === preAggregations.length - 1 && queryBody.values) {
          queryParamsReplacement = await loader.replaceQueryBuildRangeParams(queryBody.values);
        }

        return [p.tableName, usedPreAggregation];
      };

      return preAggregationPromise().then(res => preAggregationsTablesToTempTables.concat([res]));
    }).reduce((promise, fn) => promise.then(fn), Promise.resolve([]));

    return preAggregationsTablesToTempTablesPromise.then(preAggregationsTablesToTempTables => ({
      preAggregationsTablesToTempTables,
      values: queryParamsReplacement
    }));
  }

  public async checkPartitionsBuildRangeCache(queryBody) {
    const preAggregations = queryBody.preAggregations || [];

    const result = await Promise.all(preAggregations.map(async preAggregation => {
      const { preAggregationStartEndQueries } = preAggregation;

      const isCached = preAggregation.partitionGranularity ? (await Promise.all(
        preAggregationStartEndQueries.map(
          ([query, values]) => this.queryCache.resultFromCacheIfExists({ query, values })
        )
      )).every((res: any) => res?.data) : true;
      return {
        preAggregation,
        isCached
      };
    }));

    return result;
  }

  public async expandPartitionsInPreAggregations(queryBody: Query): Promise<Query> {
    const preAggregations = queryBody.preAggregations || [];

    const loadCacheByDataSource = queryBody.preAggregationsLoadCacheByDataSource || {};

    const getLoadCacheByDataSource = (dataSource = 'default', preAggregationSchema) => {
      if (!loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`]) {
        loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`] =
          new PreAggregationLoadCache(
            this.redisPrefix,
            () => this.driverFactory(dataSource),
            this.queryCache,
            this,
            {
              requestId: queryBody.requestId,
              dataSource
            }
          );
      }

      return loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`];
    };

    const expandedPreAggregations: PreAggregationDescription[][] = await Promise.all(preAggregations.map(p => {
      const loader = new PreAggregationPartitionRangeLoader(
        this.redisPrefix,
        () => this.driverFactory(p.dataSource || 'default'),
        this.logger,
        this.queryCache,
        this,
        p,
        [],
        getLoadCacheByDataSource(p.dataSource, p.preAggregationsSchema),
        {
          maxPartitions: this.options.maxPartitions,
          maxSourceRowLimit: this.options.maxSourceRowLimit,
          waitForRenew: queryBody.renewQuery,
          requestId: queryBody.requestId,
          externalRefresh: this.externalRefresh,
        },
      );

      return loader.partitionPreAggregations();
    }));

    expandedPreAggregations.forEach((preAggs) => preAggs.forEach(p => {
      p.expandedPartition = true;
    }));

    return {
      ...queryBody,
      preAggregations: expandedPreAggregations.reduce((a, b) => a.concat(b), []),
      groupedPartitionPreAggregations: expandedPreAggregations
    };
  }

  public async getQueue(dataSource: string = 'default') {
    if (!this.queue[dataSource]) {
      this.queue[dataSource] = QueryCache.createQueue(
        `SQL_PRE_AGGREGATIONS_${this.redisPrefix}_${dataSource}`,
        () => this.driverFactory(dataSource),
        (client, q) => {
          const {
            preAggregation, preAggregationsTablesToTempTables, newVersionEntry, requestId, invalidationKeys, buildRangeEnd
          } = q;
          const loader = new PreAggregationLoader(
            this.redisPrefix,
            () => this.driverFactory(dataSource),
            this.logger,
            this.queryCache,
            this,
            preAggregation,
            preAggregationsTablesToTempTables,
            new PreAggregationLoadCache(
              this.redisPrefix,
              () => this.driverFactory(dataSource),
              this.queryCache,
              this,
              { requestId, dataSource }
            ),
            { requestId, externalRefresh: this.externalRefresh, buildRangeEnd }
          );
          return loader.refresh(newVersionEntry, invalidationKeys, client);
        },
        {
          concurrency: 1,
          logger: this.logger,
          cacheAndQueueDriver: this.options.cacheAndQueueDriver,
          redisPool: this.options.redisPool,
          // Centralized continueWaitTimeout that can be overridden in queueOptions
          continueWaitTimeout: this.options.continueWaitTimeout,
          ...(await this.options.queueOptions(dataSource)),
          getQueueEventsBus: this.getQueueEventsBus,
        }
      );
    }
    return this.queue[dataSource];
  }

  /**
   * Returns registered queries queues hash table.
   */
  public getQueues(): {[dataSource: string]: QueryQueue} {
    return this.queue;
  }

  public getLoadCacheQueue(dataSource: string = 'default') {
    if (!this.loadCacheQueue[dataSource]) {
      this.loadCacheQueue[dataSource] = QueryCache.createQueue(
        `SQL_PRE_AGGREGATIONS_CACHE_${this.redisPrefix}_${dataSource}`,
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        () => <BaseDriver> {},
        (_, q) => {
          const {
            preAggregation,
            requestId
          } = q;
          const loadCache = new PreAggregationLoadCache(
            this.redisPrefix,
            () => this.driverFactory(dataSource),
            this.queryCache,
            this,
            { requestId, dataSource }
          );
          return loadCache.fetchTables(preAggregation);
        },
        {
          getQueueEventsBus: this.getQueueEventsBus,
          concurrency: 4,
          logger: this.logger,
          cacheAndQueueDriver: this.options.cacheAndQueueDriver,
          redisPool: this.options.redisPool,
          ...this.options.loadCacheQueueOptions
        }
      );
    }
    return this.loadCacheQueue[dataSource];
  }

  public static preAggregationQueryCacheKey(preAggregation) {
    return preAggregation.tableName;
  }

  public static targetTableName(versionEntry): string {
    if (versionEntry.naming_version === 2) {
      return `${versionEntry.table_name}_${versionEntry.content_version}_${versionEntry.structure_version}_${encodeTimeStamp(versionEntry.last_updated_at)}`;
    }

    return `${versionEntry.table_name}_${versionEntry.content_version}_${versionEntry.structure_version}_${versionEntry.last_updated_at}`;
  }

  public static structureVersion(preAggregation) {
    return getStructureVersion(preAggregation);
  }

  public async getVersionEntries(preAggregations: PreAggregationDescription[], requestId): Promise<VersionEntry[][]> {
    const loadCacheByDataSource = {};

    const getLoadCacheByDataSource = (dataSource = 'default', preAggregationSchema) => {
      if (!loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`]) {
        loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`] =
          new PreAggregationLoadCache(
            this.redisPrefix,
            () => this.driverFactory(dataSource),
            this.queryCache,
            this,
            {
              requestId,
              dataSource
            }
          );
      }

      return loadCacheByDataSource[`${dataSource}_${preAggregationSchema}`];
    };

    const firstByCacheKey = {};
    const data: VersionEntry[][] = await Promise.all(
      preAggregations.map(
        async preAggregation => {
          const { dataSource, preAggregationsSchema } = preAggregation;
          const cacheKey = getLoadCacheByDataSource(dataSource, preAggregationsSchema).tablesRedisKey(preAggregation);
          if (!firstByCacheKey[cacheKey]) {
            firstByCacheKey[cacheKey] = getLoadCacheByDataSource(dataSource, preAggregationsSchema).getVersionEntries(preAggregation);
            const res = await firstByCacheKey[cacheKey];
            return res.versionEntries;
          }

          return null;
        }
      )
    );
    return data.filter(res => res);
  }

  public async getQueueState(dataSource: string) {
    const query = await this.getQueue(dataSource);
    const queries = await query.getQueries();
    return queries;
  }

  public async cancelQueriesFromQueue(queryKeys: string[], dataSource: string) {
    const queue = await this.getQueue(dataSource);
    return Promise.all(queryKeys.map(queryKey => queue.cancelQuery(queryKey)));
  }
}
