import { Merkle, MerkleHasher } from '@0xcert/merkle';
import { sha } from '@0xcert/utils';
import { cloneObject, readPath, stepPaths, toString } from '../utils/data';
import { PropPath, PropRecipe } from './prop';

/**
 * Certification class configuration interface.
 */
export interface CertConfig {
  schema: any;
  hasher?: MerkleHasher;
}

/**
 * Main certification class.
 */
export class Cert {
  protected schema: any;
  protected merkle: Merkle;

  /**
   * Returns a new instance of a Cert class.
   * @param config Certificate configuration.
   */
  public static getInstance(config: CertConfig): Cert {
    return new Cert(config);
  }

  /**
   * Class constructor.
   * @param config Certificate configuration.
   */
  public constructor(config: CertConfig) {
    this.schema = config.schema;

    this.merkle = new Merkle({
      hasher: (v: any) => sha(256, toString(v)),
      ...config,
    });
  }

  /**
   * Returns a complete list of recipes for the entiry data object.
   * @param data Complete data object.
   */
  public async notarize(data: any): Promise<PropRecipe[]> {
    const schemaProps = this.buildSchemaProps(data);
    const compoundProps = await this.buildCompoundProps(schemaProps);
    const schemaRecipes = await this.buildRecipes(compoundProps);

    return schemaRecipes.map((recipe: PropRecipe) => ({
      path: recipe.path,
      nodes: recipe.nodes,
      values: recipe.values,
    }));
  }

  /**
   * Returns the minimal list of recipes needed to verify the provided data.
   * @param data Complete data object.
   * @param paths Property paths to be disclosed to a user.
   */
  public async disclose(data: any, paths: PropPath[]): Promise<PropRecipe[]> {
    const schemaProps = this.buildSchemaProps(data);
    const compoundProps = await this.buildCompoundProps(schemaProps);
    const schemaRecipes = await this.buildRecipes(compoundProps, paths);

    return schemaRecipes.map((recipe: PropRecipe) => ({
      path: recipe.path,
      nodes: recipe.nodes,
      values: recipe.values,
    }));
  }

  /**
   * Returns an imprint when all the property values of the provided `data` are
   * described with the `recipes`. Note that custom data properties will always
   * be ignored and will thus always pass.
   * @param data Complete data object.
   * @param recipes Data object recipes.
   */
  public async calculate(data: any, recipes: PropRecipe[]): Promise<string> {
    try {
      if (this.checkDataInclusion(data, recipes)) {
        return this.imprintRecipes(recipes);
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  /**
   * Calculates merkle tree root node for the provided `data`.
   * @param data Complete data object.
   */
  public async imprint(data: any): Promise<string> {
    return this.notarize(data)
      .then((n: PropRecipe[]) => n[0].nodes[0].hash);
  }

  /**
   * Converts data object to a list of property values. The list will include
   * only properties defined by the schema but will not include compound
   * properties.
   * @param data Arbitrary data object.
   * @param schema Used for recursive processing.
   * @param prepend Used for recursive processing.
   */
  protected buildSchemaProps(data: any, schema = this.schema, prepend = []): any {
    if (schema.type === 'array') {
      return (data || [])
        .map((v, i) => {
          return this.buildSchemaProps(v, schema.items, [...prepend, i]);
        })
        .reduce((a, b) => a.concat(b), []);
    } else if (schema.type === 'object') {
      return Object.keys(schema.properties)
        .sort()
        .map((key: string) => {
          const prop = this.buildSchemaProps((data || {})[key], schema.properties[key], [...prepend, key]);
          return ['object', 'array'].indexOf(schema.properties[key].type) === -1 ? [prop] : prop;
        })
        .reduce((a, b) => a.concat(b), []);
    } else {
      return {
        path: prepend,
        value: data,
        key: prepend.join('.'),
        group: prepend.slice(0, -1).join('.'),
      };
    }
  }

  /**
   * Upgrades the provided list of data properties with properties of type array
   * and object. These parents have value that equals the root merkle hash of
   * the subordinated object.
   * @param props Data properties.
   */
  protected async buildCompoundProps(props): Promise<any> {
    props = [...props];

    const groupsByName = this.buildPropGroups(props);
    const groups = Object.keys(groupsByName).sort((a, b) => a > b ? -1 : 1)
      .filter((g: string) => g !== '');

    for (const group of groups) {
      const path = groupsByName[group];
      const values = [...props.filter((i: any) => i.group === group)]
        .sort((a, b) => a.key > b.key ? 1 : -1)
        .map((i: any) => i.value);

      const recipes = await this.merkle.notarize(values);
      props.push({
        path,
        value: recipes.nodes[0].hash,
        key: path.join('.'),
        group: path.slice(0, -1).join('.'),
      });
    }

    return props.sort((a, b) => a.key > b.key ? 1 : -1);
  }

  /**
   * Calculates and returns recipes build for each data property. When providing
   * the `paths` only the recipes and recipe data needed for the required
   * properties are included in the result.
   * @param props List of schema properties.
   * @param paths Required propertiy paths.
   */
  protected async buildRecipes(props, paths = null): Promise<any> {
    const keys = paths ? stepPaths(paths).map((p: any) => p.join('.')) : null;

    const groups = {};
    props.forEach((p: any) => groups[p.group] = p.path.slice(0, -1));

    return Promise.all(
      Object.keys(groups).map(async (group: any) => {
        const values = props
          .filter((p: any) => p.group === group)
          .map((p: any) => p.value);

        let recipes = await this.merkle.notarize(values);
        if (keys) {
          const expose = props
            .filter((p: any) => p.group === group)
            .map((p, i) => keys.indexOf(p.key) === -1 ? -1 : i)
            .filter((i: any) => i !== -1);

          recipes = await this.merkle.disclose(recipes, expose);
        }

        if (!keys || keys.indexOf(groups[group].join('.')) !== -1) {
          return {
            path: groups[group],
            values: recipes.values,
            nodes: recipes.nodes,
            key: groups[group].join('.'),
            group: groups[group].slice(0, -1).join('.'),
          };
        }
      }),
    ).then((r: any) => {
      return r.filter((v: any) => !!v);
    });
  }

  /**
   * Returns `true` when all the property values of the provided `data` are
   * described with the `recipes`. Note that custom data properties (including
   * defined fields of undefined value) will always be ignored and will thus
   * always pass.
   * @param data Complete data object.
   * @param recipes Data recipes.
   */
  protected checkDataInclusion(data: any, recipes: PropRecipe[]): boolean {
    const schemaProps = this.buildSchemaProps(data);

    recipes = cloneObject(recipes).map((p: any) => ({
      key: p.path.join('.'),
      group: p.path.slice(0, -1).join('.'),
      ...p,
    }));

    for (const prop of schemaProps) {
      const dataValue = readPath(prop.path, data);

      if (typeof dataValue === 'undefined') {
        continue;
      }

      const recipeGroup = prop.path.slice(0, -1).join('.');
      const recipe = recipes.find((p: any) => p['key'] === recipeGroup);
      if (!recipe) {
        return false;
      }

      const dataIndex = this.getPathIndexes(prop.path).pop();
      const recipeValue = recipe.values.find((v: any) => v.index === dataIndex);
      if (recipeValue.value !== dataValue) {
        return false;
      }
    }

    return true;
  }

  /**
   * Calculates merkle tree root node from the provided recipes.
   * @param recipes Data recipes.
   */
  protected async imprintRecipes(recipes: PropRecipe[]): Promise<string> {
    if (recipes.length === 0) {
      return this.getEmptyImprint();
    }

    recipes = cloneObject(recipes).map((prop: any) => ({
      key: prop.path.join('.'),
      group: prop.path.slice(0, -1).join('.'),
      ...prop,
    })).sort((a, b) => a.path.length > b.path.length ? -1 : 1);

    for (const recipe of recipes) {
      const imprint = await this.merkle.imprint(recipe).catch(() => '');
      recipe.nodes.unshift({
        index: 0,
        hash: imprint,
      });

      const groupKey = recipe.path.slice(0, -1).join('.');
      const groupIndex = this.getPathIndexes(recipe.path).slice(-1).pop();
      const groupRecipe = recipes.find((p: any) => p['key'] === groupKey);
      if (groupRecipe) {
        groupRecipe.values.unshift({ // adds posible duplicate thus use `unshift`
          index: groupIndex,
          value: imprint,
        });
      }
    }

    const rootRecipe = recipes.find((f: any) => f['key'] === '');
    if (rootRecipe) {
      return rootRecipe.nodes.find((n: any) => n.index === 0).hash;
    } else {
      return this.getEmptyImprint();
    }
  }

  /**
   * Returns an index of a property based on the schema object definition.
   * @param path Property path.
   */
  protected getPathIndexes(keys: PropPath): number[] {
    const indexes = [];
    let schema = this.schema;

    for (const key of keys) {
      if (schema.type === 'array') {
        indexes.push(key);
        schema = schema.items;
      } else if (schema.type === 'object') {
        indexes.push(
          Object.keys(schema.properties).sort().indexOf(key as string),
        );
        schema = schema.properties[key];
      } else {
        indexes.push(undefined);
      }
    }

    return indexes;
  }

  /**
   * Returns a hash of an empty value.
   */
  protected async getEmptyImprint(): Promise<any> {
    return this.merkle.notarize([]).then((e: any) => e.nodes[0].hash);
  }

  /**
   * Returns a hash of groups where the key represents group name and the value
   * represents group path.
   * @param props List of properties.
   */
  protected buildPropGroups(props): any {
    const groups = {};

    props.map((p: any) => {
      const path = [];
      return p.path.map((v: any) => {
        path.push(v);
        return [...path];
      });
    }).reduce((a, b) => a.concat(b), []).forEach((p: any) => {
      return groups[p.slice(0, -1).join('.')] = p.slice(0, -1);
    });

    return groups;
  }

}
