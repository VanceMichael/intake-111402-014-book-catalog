import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collect} from './reader.mjs';
import {Archive} from './archive.mjs';
import {Catalog} from './catalog.mjs';
import {createApi} from './api.mjs';

const dataDir = resolve(process.env.DATA_DIR ?? '.state');
const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(dataDir);
const catalog = new Catalog(dataDir);
const api = await createApi(archive,catalog,Number(process.env.PORT ?? 4020));
console.log(JSON.stringify({source:source.origin,api:api.origin}));
try {
  const rows = await collect(createClient(source.origin));
  const provenance = {source:source.origin,adapter:'block-aware'};
  console.log(JSON.stringify({archive:await archive.put(rows,provenance),catalog:await catalog.apply(rows,provenance)}));
} catch(error) {console.error(error.message);}
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
