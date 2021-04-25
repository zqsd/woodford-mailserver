import {createPool, TransactionCancelError} from 'cockroach';

const pool = createPool({});
pool.TransactionCancelError = TransactionCancelError;

export default pool;