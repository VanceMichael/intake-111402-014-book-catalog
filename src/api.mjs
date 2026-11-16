import {createServer} from 'node:http';
export async function createApi(archive,catalog,port = 0) {
  const server = createServer(async (request,response) => {
    try {
      const url = new URL(request.url,'http://127.0.0.1');
      if (request.method !== 'GET') {response.writeHead(405,{'content-type':'application/json'});return response.end(JSON.stringify({error:'method not allowed'}));}
      const send = (status,data) => {response.writeHead(status,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(data,null,2));};
      if (url.pathname === '/health') return send(200,{status:'ok'});
      // 原件归档：每条来源消息的原始投递记录与摘要，不代表业务当前值。
      if (url.pathname === '/records') return send(200,await archive.list());
      if (catalog) {
        // 业务投影：分块覆盖、逐字段来源、撤回状态与缺失块巡检。
        if (url.pathname === '/products') return send(200,await catalog.list());
        const productMatch = url.pathname.match(/^\/products\/(.+)$/);
        if (productMatch) {
          const product = await catalog.get(decodeURIComponent(productMatch[1]));
          return product ? send(200,product) : send(404,{error:'product not found'});
        }
        if (url.pathname === '/conflicts') return send(200,await catalog.conflicts());
      }
      return send(404,{error:'unknown resource',path:url.pathname});
    } catch(error) {
      response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:error.message}));
    }
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:() => new Promise(resolve => server.close(resolve))};
}
