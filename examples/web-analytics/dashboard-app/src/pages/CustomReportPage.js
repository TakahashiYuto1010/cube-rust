import React, { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@apollo/react-hooks";
import Button from "@material-ui/core/Button";
import Grid from "@material-ui/core/Grid";
import { GET_CUSTOM_REPORT } from "../graphql/queries";
import OverTimeChart from "../components/OverTimeChart";
import DataTable from "../components/DataTable";
import Dropdown from "../components/Dropdown";
import { Link } from "react-router-dom";

const CustomReportPage = ({ withTime }) => {
  const [activeMeasure, setActiveMeasure] = useState(null);
  const { id } = useParams();
  const { loading, error, data } = useQuery(GET_CUSTOM_REPORT, {
    variables: {
      id: id
    },
  });
  if (loading || error) {
    return "Loading";
  }

  const { measures, ...query } = JSON.parse(data.customReport.query);
  const finalActiveMeasure = activeMeasure || measures[0];
  const overTimeChartQuery = {
    measures: [finalActiveMeasure],
    timeDimensions: [{
      dimension: query.timeDimensions[0].dimension,
      granularity: 'day'
    }]
  };
  const dataTableQuery = {
    ...query,
    timeDimensions: [{
      dimension: query.timeDimensions[0].dimension,
    }]
  };
  return (
    <>
      <Grid item xs={12}>
        <Grid container justify="flex-end">
          <Button component={Link} to={`/custom-reports-builder/${id}`} variant="contained">
            Edit
          </Button>
        </Grid>
      </Grid>
      <Grid item xs={12}>
        <OverTimeChart
          title={
            measures.length > 1 ?
              <Dropdown
                value={finalActiveMeasure}
                options={
                  measures.reduce((out, measure) => {
                    out[measure] = () => setActiveMeasure(measure)
                    return out;
                  }, {})
                }
              /> : finalActiveMeasure
          }
          vizState={withTime({ query: overTimeChartQuery, chartType: 'line' })}
        />
      </Grid>
      <Grid item xs={12}>
        <DataTable query={withTime({ query: dataTableQuery, chartType: 'table' })} />
      </Grid>
    </>
  )
};

export default CustomReportPage;
