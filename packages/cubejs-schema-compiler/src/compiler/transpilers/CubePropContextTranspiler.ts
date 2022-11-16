import * as t from '@babel/types';
import R from 'ramda';
import { NodePath } from '@babel/traverse';

import { TranspilerInterface, TraverseObject } from './transpiler.interface';
import type { CubeSymbols } from '../CubeSymbols';
import type { CubeDictionary } from '../CubeDictionary';

/* this list was generated by getTransformPatterns() */
export const transpiledFieldsPatterns: Array<RegExp> = [
  /\.sql$/,
  /sql$/,
  /^measures\.[_a-zA-Z][_a-zA-Z0-9]*\.(drillMemberReferences|drillMembers)$/,
  /^preAggregations\.[_a-zA-Z][_a-zA-Z0-9]*\.indexes\.[_a-zA-Z][_a-zA-Z0-9]*\.columns$/,
  /^preAggregations\.[_a-zA-Z][_a-zA-Z0-9]*\.(timeDimensionReference|timeDimension|segments|dimensions|measures|rollups|segmentReferences|dimensionReferences|measureReferences|rollupReferences)$/,
  /^contextMembers$/,
  /^includes$/,
  /^excludes$/,
];

export const transpiledFields: Set<String> = new Set<String>();

transpiledFieldsPatterns?.forEach((r) => {
  const fields = r.toString().replace(/.*?([_a-zA-Z|][_a-zA-Z0-9|]*)([^_a-zA-Z0-9|]*)$/, '$1').split('|');
  fields.forEach((f) => transpiledFields.add(f));
});

export class CubePropContextTranspiler implements TranspilerInterface {
  public constructor(
    protected readonly cubeSymbols: CubeSymbols,
    protected readonly cubeDictionary: CubeDictionary,
  ) {
  }

  public traverseObject(): TraverseObject {
    return {
      CallExpression: (path) => {
        if (t.isIdentifier(path.node.callee)) {
          const args = path.get('arguments');
          if (path.node.callee.name === 'cube' || path.node.callee.name === 'view') {
            if (args?.[args.length - 1]) {
              const cubeName = args[0].node.type === 'StringLiteral' && args[0].node.value ||
                args[0].node.type === 'TemplateLiteral' &&
                args[0].node.quasis.length &&
                args[0].node.quasis[0].value.cooked;
              args[args.length - 1].traverse(this.sqlAndReferencesFieldVisitor(cubeName));
              args[args.length - 1].traverse(
                this.knownIdentifiersInjectVisitor('extends', name => this.cubeDictionary.resolveCube(name))
              );
            }
          } else if (path.node.callee.name === 'context') {
            args[args.length - 1].traverse(this.sqlAndReferencesFieldVisitor(null));
          }
        }
      }
    };
  }

  protected transformObjectProperty(path: NodePath<t.ObjectProperty>, resolveSymbol: (name: string) => void) {
    CubePropContextTranspiler.replaceValueWithArrowFunction(resolveSymbol, path.get('value'));
  }

  public static replaceValueWithArrowFunction(resolveSymbol: (name: string) => any, value: NodePath<any>) {
    const knownIds = CubePropContextTranspiler.collectKnownIdentifiers(
      resolveSymbol,
      value,
    );
    value.replaceWith(
      t.arrowFunctionExpression(
        knownIds.map(i => t.identifier(i)),
        // @todo Replace any with assert expression
        <any>value.node,
        false,
      ),
    );
  }

  protected sqlAndReferencesFieldVisitor(cubeName): TraverseObject {
    const resolveSymbol = n => this.cubeSymbols.resolveSymbol(cubeName, n) || this.cubeSymbols.isCurrentCube(n);

    return {
      ObjectProperty: (path) => {
        if (path.node.key.type === 'Identifier' && transpiledFields.has(path.node.key.name)) {
          const fullPath = this.fullPath(path);
          // eslint-disable-next-line no-restricted-syntax
          for (const p of transpiledFieldsPatterns) {
            if (fullPath.match(p)) {
              this.transformObjectProperty(path, resolveSymbol);
              return;
            }
          }
        }
      }
    };
  }

  protected fullPath(path: NodePath<t.ObjectProperty>): string {
    // @ts-ignore
    let fp = path?.node?.key?.name || '';
    let pp: NodePath<t.Node> | null | undefined = path?.parentPath;
    while (pp) {
      if (pp?.parentPath?.node?.type === 'ArrayExpression') {
        fp = `0.${fp}`;
        pp = pp?.parentPath;
        // @ts-ignore
      } else if (pp?.parentPath?.node?.key?.type === 'Identifier') {
        // @ts-ignore
        fp = `${pp?.parentPath?.node?.key?.name || '0'}.${fp}`;
        pp = pp?.parentPath?.parentPath;
      } else break;
    }

    return fp;
  }

  protected knownIdentifiersInjectVisitor(field: RegExp | string, resolveSymbol: (name: string) => void): TraverseObject {
    return {
      ObjectProperty: (path) => {
        if (path.node.key.type === 'Identifier' && path.node.key.name.match(field)) {
          this.transformObjectProperty(path, resolveSymbol);
        }
      }
    };
  }

  protected static collectKnownIdentifiers(resolveSymbol, path: NodePath) {
    const identifiers = [];

    if (path.node.type === 'Identifier') {
      CubePropContextTranspiler.matchAndPushIdentifier(path, resolveSymbol, identifiers);
    }

    path.traverse({
      Identifier: (p) => {
        CubePropContextTranspiler.matchAndPushIdentifier(p, resolveSymbol, identifiers);
      }
    });

    return R.uniq(identifiers);
  }

  protected static matchAndPushIdentifier(path, resolveSymbol, identifiers) {
    if (
      (!path.parent ||
        (path.parent.type !== 'MemberExpression' || path.parent.type === 'MemberExpression' && path.key !== 'property')
      ) &&
      resolveSymbol(path.node.name)
    ) {
      identifiers.push(path.node.name);
    }
  }
}
