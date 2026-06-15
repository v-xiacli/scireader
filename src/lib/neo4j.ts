import neo4j, { type Driver } from 'neo4j-driver';

let driver: Driver | null | undefined;

const isDatabaseSelectionError = (error: unknown) =>
  error instanceof Error && /database|not found|does not exist|requested database/i.test(error.message);

const getNeo4jConfig = () => {
  const uri = process.env.NEO4J_URI?.trim();
  const username = process.env.NEO4J_USERNAME?.trim();
  const password = process.env.NEO4J_PASSWORD?.trim();
  const database = process.env.NEO4J_DATABASE?.trim() || 'neo4j';

  if (!uri || !username || !password) return null;

  return { uri, username, password, database };
};

const getNeo4jDriver = () => {
  if (driver !== undefined) return driver;

  const config = getNeo4jConfig();

  if (!config) {
    driver = null;
    return driver;
  }

  driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password));
  return driver;
};

export const isNeo4jConfigured = () => Boolean(getNeo4jConfig());

export const writeNeo4j = async (query: string, params: Record<string, unknown> = {}) => {
  const activeDriver = getNeo4jDriver();
  const config = getNeo4jConfig();

  if (!activeDriver || !config) return { skipped: true };

  const runWithDatabase = async (database?: string) => {
    const session = activeDriver.session(database ? { database } : undefined);

    try {
      await session.executeWrite((transaction) => transaction.run(query, params));
    } finally {
      await session.close();
    }
  };

  try {
    await runWithDatabase(config.database);
  } catch (error) {
    if (!isDatabaseSelectionError(error)) throw error;
    await runWithDatabase();
  }

  return { skipped: false };
};

export const readNeo4j = async <T>(query: string, params: Record<string, unknown> = {}, mapRecord: (record: neo4j.Record) => T) => {
  const activeDriver = getNeo4jDriver();
  const config = getNeo4jConfig();

  if (!activeDriver || !config) return { skipped: true, records: [] as T[] };

  const runWithDatabase = async (database?: string) => {
    const session = activeDriver.session(database ? { database } : undefined);

    try {
      return await session.executeRead((transaction) => transaction.run(query, params));
    } finally {
      await session.close();
    }
  };

  try {
    let result;

    try {
      result = await runWithDatabase(config.database);
    } catch (error) {
      if (!isDatabaseSelectionError(error)) throw error;
      result = await runWithDatabase();
    }

    return {
      skipped: false,
      records: result.records.map(mapRecord),
    };
  }
};
