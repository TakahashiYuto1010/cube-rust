import { jest, expect, beforeAll, afterAll } from '@jest/globals';
import cubejs, { Query, CubejsApi } from '@cubejs-client/core';
import WebSocketTransport from '@cubejs-client/ws-transport';

import { BirdBox } from '../src';

type QueryTestOptions = {
  name: string;
  ws?: true,
};

const asserts: [options: QueryTestOptions, query: Query][] = [
  [
    { name: 'Rolling' },
    {
      measures: [
        'visitors.checkinsRollingTotal',
      ],
      dimensions: [
        'visitors.source'
      ],
      timezone: 'UTC',
      timeDimensions: [{
        dimension: 'visitors.createdAt',
        granularity: 'day',
        dateRange: ['2017-01-02', '2017-01-05']
      }],
      order: {
        'visitors.createdAt': 'asc',
        'visitors.source': 'asc'
      }
    }
  ],
  [
    { name: 'Rolling Mixed' },
    {
      measures: [
        'visitors.checkinsRollingTotal',
        'visitors.count',
        'visitors.checkinsRolling2day'
      ],
      timezone: 'UTC',
      timeDimensions: [{
        dimension: 'visitors.createdAt',
        granularity: 'day',
        dateRange: ['2017-01-02', '2017-01-05']
      }],
      order: {
        'visitors.createdAt': 'asc'
      }
    }
  ],
  [
    { name: 'Rolling Mixed With Dimension' },
    {
      measures: [
        'visitors.checkinsRollingTotal',
        'visitors.count',
        'visitors.checkinsRolling2day'
      ],
      dimensions: [
        'visitors.source'
      ],
      timezone: 'UTC',
      timeDimensions: [{
        dimension: 'visitors.createdAt',
        granularity: 'day',
        dateRange: ['2017-01-02', '2017-01-05']
      }],
      order: {
        'visitors.createdAt': 'asc',
        'visitors.source': 'asc'
      }
    }
  ]
];

// eslint-disable-next-line import/prefer-default-export
export function createBirdBoxTestCase(name: string, entrypoint: () => Promise<BirdBox>) {
  describe(name, () => {
    jest.setTimeout(60 * 5 * 1000);

    let birdbox: BirdBox;
    let httpClient: CubejsApi;
    let wsClient: CubejsApi;
    let wsTransport: WebSocketTransport;

    // eslint-disable-next-line consistent-return
    beforeAll(async () => {
      // Fail fast
      try {
        birdbox = await entrypoint();

        httpClient = cubejs(async () => 'test', {
          apiUrl: birdbox.configuration.apiUrl,
        });

        wsTransport = new WebSocketTransport({
          apiUrl: birdbox.configuration.apiUrl,
        });
        wsClient = cubejs(async () => 'test', {
          apiUrl: birdbox.configuration.apiUrl,
          transport: wsTransport,
        });
      } catch (e) {
        console.log(e);
        process.exit(1);
      }
    });

    // eslint-disable-next-line consistent-return
    afterAll(async () => {
      await wsTransport.close();

      await birdbox.stop();
    });

    describe('HTTP Transport', () => {
      // eslint-disable-next-line no-restricted-syntax
      for (const [options, query] of asserts) {
        // eslint-disable-next-line no-loop-func
        it(`${options.name}`, async () => {
          const response = await httpClient.load(query);
          expect(response.rawData()).toMatchSnapshot(options.name);
        });
      }
    });
  });
}
