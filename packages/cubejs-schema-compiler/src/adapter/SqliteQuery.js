import * as moment from 'moment-timezone';

import { BaseQuery } from './BaseQuery';
import { BaseFilter } from './BaseFilter';

const GRANULARITY_TO_INTERVAL = {
  day: (date) => `strftime('%Y-%m-%dT00:00:00.000', ${date})`,
  week: (date) => `strftime('%Y-%m-%dT00:00:00.000', CASE WHEN date(${date}, 'weekday 1') = date(${date}) THEN date(${date}, 'weekday 1') ELSE date(${date}, 'weekday 1', '-7 days') END)`,
  hour: (date) => `strftime('%Y-%m-%dT%H:00:00.000', ${date})`,
  minute: (date) => `strftime('%Y-%m-%dT%H:%M:00.000', ${date})`,
  second: (date) => `strftime('%Y-%m-%dT%H:%M:%S.000', ${date})`,
  month: (date) => `strftime('%Y-%m-01T00:00:00.000', ${date})`,
  year: (date) => `strftime('%Y-01-01T00:00:00.000', ${date})`
};

class SqliteFilter extends BaseFilter {
  likeIgnoreCase(column, not, param) {
    return `${column}${not ? ' NOT' : ''} LIKE '%' || ${this.allocateParam(param)} || '%' COLLATE NOCASE`;
  }
}

export class SqliteQuery extends BaseQuery {
  newFilter(filter) {
    return new SqliteFilter(this, filter);
  }

  convertTz(field) {
    return `${this.timeStampCast(field)} || '${
      moment().tz(this.timezone).format('Z')
        .replace('-', '+')
        .replace('+', '-')
    }'`;
  }

  floorSql(numeric) {
    // SQLite doesnt support FLOOR
    return `(CAST((${numeric}) as int) - ((${numeric}) < CAST((${numeric}) as int)))`;
  }

  timeStampCast(value) {
    return `strftime('%Y-%m-%dT%H:%M:%f', ${value})`;
  }

  dateTimeCast(value) {
    return `strftime('%Y-%m-%dT%H:%M:%f', ${value})`;
  }

  subtractInterval(date, interval) {
    return `strftime('%Y-%m-%dT%H:%M:%f', ${date}, '${interval.replace('-', '+').replace(/(^\+|^)/, '-')}')`;
  }

  addInterval(date, interval) {
    return `strftime('%Y-%m-%dT%H:%M:%f', ${date}, '${interval}')`;
  }

  timeGroupedColumn(granularity, dimension) {
    return GRANULARITY_TO_INTERVAL[granularity](dimension);
  }

  seriesSql(timeDimension) {
    const values = timeDimension.timeSeries().map(
      ([from, to]) => `select '${from}' f, '${to}' t`
    ).join(' UNION ALL ');
    return `SELECT dates.f date_from, dates.t date_to FROM (${values}) AS dates`;
  }

  nowTimestampSql() {
    // eslint-disable-next-line quotes
    return `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
  }

  unixTimestampSql() {
    // eslint-disable-next-line quotes
    return `strftime('%s','now')`;
  }
}
