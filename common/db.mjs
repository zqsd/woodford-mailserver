import CockroachDB from 'cockroach';

export const db = new CockroachDB();

export function ensureTransaction(client, op) {
    if(client) {
        return op(client);
    }
    else {
        return db.transaction(op);
    }
}
