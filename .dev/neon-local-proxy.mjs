import http from 'node:http';
import pg from 'pg';

const { Pool } = pg;

// Return dates and timestamps as Postgres text, exactly like Neon's HTTP API. Turning them into
// ISO strings ('...Z') made drizzle read timestamp-without-time-zone columns as Invalid Date locally.
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (v) => v);

const DATABASE_URL = process.env.LOCAL_PG_URL || 'postgresql://outsyde:outsyde@localhost:5432/outsyde';
const PORT = parseInt(process.env.NEON_PROXY_PORT || '4444', 10);

const pool = new Pool({ connectionString: DATABASE_URL });

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/sql')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const parsed = JSON.parse(body);

    if (parsed.queries) {
      const results = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const q of parsed.queries) {
          const result = await client.query(q.query, q.params || []);
          results.push(formatResult(result));
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } else {
      const result = await pool.query(parsed.query, parsed.params || []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(formatResult(result)));
    }
  } catch (err) {
    const response = {
      message: err.message,
      severity: err.severity || 'ERROR',
      code: err.code || 'XX000',
      detail: err.detail,
      hint: err.hint,
      position: err.position,
      constraint: err.constraint,
    };
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }
});

function toPgArray(arr) {
  return '{' + arr.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return toPgArray(v);
    const t = v instanceof Date ? v.toISOString() : String(v);
    return '"' + t.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }).join(',') + '}';
}

function formatResult(result) {
  const fields = (result.fields || []).map(f => ({
    name: f.name,
    dataTypeID: f.dataTypeID,
    tableID: f.tableID || 0,
    columnID: f.columnID || 0,
    dataTypeSize: f.dataTypeSize || -1,
    dataTypeModifier: f.dataTypeModifier || -1,
    format: f.format || 'text',
  }));

  const rows = (result.rows || []).map(row => {
    return fields.map(f => {
      const val = row[f.name];
      if (val === null || val === undefined) return null;
      if (val instanceof Date) return val.toISOString();
      // Postgres arrays (e.g. text[]) come back from Neon's HTTP API as array literals ('{a,"b c"}'),
      // which the driver parses. JSON ('["a"]') would be read as an empty array.
      if (Array.isArray(val) && f.dataTypeID !== 114 && f.dataTypeID !== 3802) return toPgArray(val);
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val);
    });
  });

  return {
    command: result.command,
    rowCount: result.rowCount,
    fields,
    rows,
  };
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Neon local proxy listening on http://127.0.0.1:${PORT}/sql`);
});

process.on('SIGTERM', () => {
  server.close();
  pool.end();
});
