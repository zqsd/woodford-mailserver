import {createPool, TransactionCancelError} from 'cockroach';

const pool = createPool({
    host: '127.0.0.1',
    port: '26257',
    user: 'root',
    database: 'defaultdb',
});
pool.TransactionCancelError = TransactionCancelError;

export default pool;