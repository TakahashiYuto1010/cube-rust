import Moment from 'moment-timezone';
import { extendMoment } from 'moment-range';

import { BaseFilter } from './BaseFilter';
import { UserError } from '../compiler/UserError';

const moment = extendMoment(Moment);

const TIME_SERIES = {
  day: (range) => Array.from(range.snapTo('day').by('day'))
    .map(d => [d.format('YYYY-MM-DDT00:00:00.000'), d.format('YYYY-MM-DDT23:59:59.999')]),
  month: (range) => Array.from(range.snapTo('month').by('month'))
    .map(d => [d.format('YYYY-MM-01T00:00:00.000'), d.endOf('month').format('YYYY-MM-DDT23:59:59.999')]),
  year: (range) => Array.from(range.snapTo('year').by('year'))
    .map(d => [d.format('YYYY-01-01T00:00:00.000'), d.endOf('year').format('YYYY-MM-DDT23:59:59.999')]),
  hour: (range) => Array.from(range.snapTo('hour').by('hour'))
    .map(d => [d.format('YYYY-MM-DDTHH:00:00.000'), d.format('YYYY-MM-DDTHH:59:59.999')]),
  minute: (range) => Array.from(range.snapTo('minute').by('minute'))
    .map(d => [d.format('YYYY-MM-DDTHH:mm:00.000'), d.format('YYYY-MM-DDTHH:mm:59.999')]),
  second: (range) => Array.from(range.snapTo('second').by('second'))
    .map(d => [d.format('YYYY-MM-DDTHH:mm:ss.000'), d.format('YYYY-MM-DDTHH:mm:ss.999')]),
  week: (range) => Array.from(range.snapTo('isoweek').by('week'))
    .map(d => [d.startOf('isoweek').format('YYYY-MM-DDT00:00:00.000'), d.endOf('isoweek').format('YYYY-MM-DDT23:59:59.999')])
};

export class BaseTimeDimension extends BaseFilter {
  constructor(query, timeDimension) {
    super(query, {
      dimension: timeDimension.dimension,
      operator: 'in_date_range',
      values: timeDimension.dateRange
    });
    this.query = query;
    this.dateRange = timeDimension.dateRange;
    this.granularity = timeDimension.granularity;
  }

  selectColumns() {
    if (!this.granularity) {
      return null;
    }
    return super.selectColumns();
  }

  aliasName() {
    if (!this.granularity) {
      return null;
    }
    return super.aliasName();
  }

  unescapedAliasName(granularity) {
    const actualGranularity = granularity || this.granularity || 'day';

    return `${this.query.aliasName(this.dimension)}_${actualGranularity}`; // TODO date here for rollups
  }

  dateSeriesAliasName() {
    return this.query.escapeColumnName(`${this.dimension}_series`);
  }

  dateSeriesSelectColumn(dateSeriesAliasName) {
    if (!this.granularity) {
      return null;
    }
    return `${dateSeriesAliasName || this.dateSeriesAliasName()}.${this.query.escapeColumnName('date_from')} ${this.aliasName()}`;
  }

  dimensionSql() {
    const context = this.query.safeEvaluateSymbolContext();
    const granularity = context.granularityOverride || this.granularity;

    if (context.rollupQuery) {
      if (context.rollupGranularity === this.granularity) {
        return super.dimensionSql();
      }
      return this.query.timeGroupedColumn(granularity, this.query.dimensionSql(this));
    }
    if (context.ungrouped) {
      return this.convertedToTz();
    }
    return this.query.timeGroupedColumn(granularity, this.convertedToTz());
  }

  convertedToTz() {
    return this.query.convertTz(this.query.dimensionSql(this));
  }

  filterToWhere() {
    if (!this.dateRange) {
      return null;
    }
    return super.filterToWhere();
  }

  filterParams() {
    if (!this.dateRange) {
      return [];
    }
    return super.filterParams();
  }

  dateFromFormatted() {
    if (!this.dateFromFormattedValue) {
      this.dateFromFormattedValue = this.formatFromDate(this.dateRange[0]);
    }

    return this.dateFromFormattedValue;
  }

  dateFrom() {
    if (!this.dateFromValue) {
      this.dateFromValue = this.inDbTimeZoneDateFrom(this.dateRange[0]);
    }

    return this.dateFromValue;
  }

  dateFromParam() {
    return this.query.paramAllocator.allocateParamsForQuestionString(
      this.query.timeStampParam(this), [this.dateFrom()]
    );
  }

  localDateTimeFromParam() {
    return this.query.dateTimeCast(this.query.paramAllocator.allocateParam(this.dateFromFormatted()));
  }

  dateToFormatted() {
    if (!this.dateToFormattedValue) {
      this.dateToFormattedValue = this.formatToDate(this.dateRange[1]);
    }
    return this.dateToFormattedValue;
  }

  dateTo() {
    if (!this.dateToValue) {
      this.dateToValue = this.inDbTimeZoneDateTo(this.dateRange[1]);
    }
    return this.dateToValue;
  }

  dateToParam() {
    return this.query.paramAllocator.allocateParamsForQuestionString(
      this.query.timeStampParam(this), [this.dateTo()]
    );
  }

  localDateTimeToParam() {
    return this.query.dateTimeCast(this.query.paramAllocator.allocateParam(this.dateToFormatted()));
  }

  dateRangeGranularity() {
    if (!this.dateRange) {
      return null;
    }
    const msFrom = moment.tz(this.dateFromFormatted(), this.query.timezone);
    const msTo = moment.tz(this.dateToFormatted(), this.query.timezone).add(1, 'ms');
    return this.query.minGranularity(
      this.query.granularityFor(msFrom),
      this.query.granularityFor(msTo),
    );
  }

  rollupGranularity() {
    if (!this.rollupGranularityValue) {
      this.rollupGranularityValue =
        this.query.cacheValue(
          ['rollupGranularity', this.granularity].concat(this.dateRange),
          () => this.query.minGranularity(this.granularity, this.dateRangeGranularity())
        );
    }
    return this.rollupGranularityValue;
  }

  timeSeries() {
    if (!this.dateRange) {
      throw new UserError('Time series queries without dateRange aren\'t supported');
    }

    if (!this.granularity) {
      return [
        [this.dateFromFormatted(), this.dateToFormatted()]
      ];
    }

    if (!TIME_SERIES[this.granularity]) {
      throw new UserError(`Unsupported time granularity: ${this.granularity}`);
    }

    const range = moment.range(this.dateFromFormatted(), this.dateToFormatted());

    return TIME_SERIES[this.granularity](range);
  }
}
