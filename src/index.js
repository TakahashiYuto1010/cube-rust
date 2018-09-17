import { fetch } from 'whatwg-fetch';
import ResultSet from './ResultSet';

const API_URL = process.env.CUBEJS_API_URL;

class CubejsApi {
  constructor(apiToken) {
    this.apiToken = apiToken;
  }

  request(url, config) {
    return fetch(
      `${API_URL}${url}`,
      Object.assign({ headers: { Authorization: this.apiToken, 'Content-Type': 'application/json' }}, config || {})
    )
  }

  load(jobId, query, callback) {
    const loadImpl = async () => {
      const res = await this.request(`/load?query=${JSON.stringify(query)}`);
      const response = await res.json();
      return new ResultSet(response);
    };
    if (callback) {
      loadImpl().then(r => callback(null, r), e => callback(e));
    } else {
      return loadImpl();
    }
  }
}

export default (apiToken) => {
  return new CubejsApi(apiToken);
};