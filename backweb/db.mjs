import {createPool, TransactionCancelError} from 'cockroach';

const pool = createPool({});

export default pool;