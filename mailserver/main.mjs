import {SMTPServer} from 'smtp-server';
import {simpleParser} from 'mailparser';
//const SMTPServer = require('smtp-server').SMTPServer;
import DKIM from 'dkim';
import parseMail from 'ingress-dmgparser'; //const parseMail = require('ingress-dmgparser');
import {db, ensureTransaction} from '../common/db.mjs';
import format from 'pg-format';
import pushDamagesFromReport from './damageReportWorker.mjs';

function verifyMail(buffer) {
    return new Promise((resolve, reject) => {
        DKIM.verify(buffer, (err, results) => {
            if(err) {
                reject(err);
            }
            else {
                for(const result of results) {
                    if(result.signature.domain === 'nianticlabs.com' && result.verified) {
                        return resolve(true);
                    }
                    if(!result.verified) {
                        console.warn(`${result.signature.domain}: ${result.error}`);
                    }
                }
                resolve(process.env.NODE_ENV === 'development'); // ignore DKIM in dev
            }
        });
    });
}

function pushPortalsFromReport(report) {
    return db.transaction(client => {
        // upsert portals
        return client.query(format('INSERT INTO portals ("name", "address", "image", "latE6", "lngE6", "lastAlert") VALUES %L ON CONFLICT ("name", "address") DO UPDATE SET "image" = excluded."image", "latE6" = excluded."latE6", "lngE6" = excluded."lngE6", "lastAlert" = excluded."lastAlert"', Object.values(report.portals).map(portal => {
            return [
                portal.name,
                portal.address,
                portal.image,
                portal.latitude * 1e6,
                portal.longitude * 1e6,
                report.timestamp,
            ];
        })));
    });
}

// fix the case where we get a damage report for a portal linked to but said portal has not been attacked
function reorderLinks(damages, portals) {
    let result = [];
    for(const damage of damages) {
        if(damage.resonators === 0 && damage.mods === 0 && damage.links.length === 1 && portals[damage.portal].resonators >= 2 && portals[damage.links[0]].resonators < 2) {
            // switch the two portals
            result.push(Object.assign({}, damage, {
                portal: damage.links[0],
                links: damage.portal,
            }));
        }
        // normal case
        else {
            result.push(damage);
        }
    }
    return result;
}

async function readDamageReport(data, mail) {
    if(await verifyMail(Buffer.from(data))) {
        const report = await parseMail(data);
        //console.log(report);
        const attackee = report.agents[report.attackee];
        const attacker = report.agents[report.damages[0].attacker];
        console.log(`damage report for ${attackee.name} <${attackee.email}>, attacked by ${attacker.name}`);

        report.damages = reorderLinks(report.damages, report.portals);

        await Promise.all([
            pushDamagesFromReport(report), // notification filter must be quick, no db lookup done
            pushPortalsFromReport(report), // fill the db with damage report data, can wait
        ]);
    }
    else {
        console.error(`failed to verify email from ${mail.from.value[0].address} to ${mail.to.value[0].address} entitled "${mail.subject}". skipping.`);
    }
}

async function mailRouter(data) {
    const mail = await simpleParser(data);
    if(mail.from && mail.to) {
        if(mail.subject.startsWith('Ingress Damage Report: Entities attacked by ') && mail.from.value[0].address === 'ingress-support@nianticlabs.com') {
            await readDamageReport(data, mail);
        }
        else {
            log.info(`ignored email from ${mail.from.value[0].address} to ${mail.to.value[0].address} : ${mail.subject}`);
        }
    }
}

const server = new SMTPServer({
    authOptional: true,
    disableReverseLookup: true,
    // starttls
    //key: fs.readFileSync(config.mail.key),
    //cert: fs.readFileSync(config.mail.cert),
    requestCert: true,

    async onData(stream, session, callback) {
        // read complete mail before sending to simpleParser. giving it a stream was breaking words sometimes
        const data = await new Promise((resolve) => {
            let res = '';
            stream.on('data', (chunk) => res += chunk.toString());
            stream.on('end', () => resolve(res));
        });
        await mailRouter(data);
        return callback();
    }
});

server.listen(process.env.MAIL_PORT);
server.on('error', err => {
    console.log('Error %s', err.message);
});