import React from 'react';

import { GridContext, GridProps } from './Grid';

export type GridItemProps = {
  imageUrl: string;
  title: string;
  url: string;
};

export const GridItem = ({
  imageUrl,
  title,
  url,
}: GridItemProps) => {
  return (
    <GridContext.Consumer>
      {(value) => {
        const settings = JSON.parse(value) as GridProps;
        const [ width, height ] = settings.imageSize ?? [];

        return (
          <div className="grid-item">
            <a href={url}>
              <div className="card">
                <div className="card__image">
                  <img
                    src={imageUrl}
                    alt={title}
                    width={width}
                    height={height}
                  />
                </div>
                <div className="card__title">{title}</div>
              </div>
            </a>
          </div>
        );
      }}
    </GridContext.Consumer>
  );
};
