import styled from 'styled-components';
import { Alert as AntdAlert } from 'antd';

export const TYPES: any = {
  error: {
    border: '#FFCCC7',
    background: 'rgb(255, 100, 109, 0.05)',
    color: '#EF404A',
  },
  warning: {
    border: '#FFE58F',
    background: '#FFFBE6',
  },
  info: {
    border: '#91D5FF',
    background: '#E6F7FF',
  },
  success: {
    border: '#B7EB8F',
    background: '#F6FFED',
  },
};

export const Alert: typeof AntdAlert = styled(AntdAlert)`
  && {
    background: ${(props) => TYPES[props.type || 'info'].background};
    border: 1px solid ${(props) => TYPES[props.type || 'info'].border};
    color: ${(props) => (props.type && TYPES[props.type]?.color) || 'inherit'};
    box-sizing: border-box;
    border-radius: 2px;
  }
`;
