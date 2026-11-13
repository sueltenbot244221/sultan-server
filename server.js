 use strict ;

const http = require( http );

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY ||   ;
const MODEL = process.env.MODEL ||  gemini-2.0-flash ;
const SYSTEM =  أنت «السلطان»، مساعد صوتي ودود وخفيف الدم. ردودك قصيرة، وبدايتها وسم مثل [happy]. ;

const server = http.createServer(async (req, res) => {
  if (req.method ===  GET  && req.url ===  /health ) {
    res.writeHead(200, {  Content-Type :  application/json  });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method !==  POST  || req.url !==  /chat ) {
    res.writeHead(404, {  Content-Type :  application/json  });
    return res.end(JSON.stringify({ error:  not_found  }));
  }

  let body =   ;
  req.on( data , chunk => { body += chunk; });
  req.on( end , async () => {
    try {
      const data = JSON.parse(body);
      const message = data.message ||  مرحباً ;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
      const r = await fetch(url, {
        method:  POST ,
        headers: {  Content-Type :  application/json ,  x-goog-api-key : API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role:  user , parts: [{ text: message }] }]
        })
      });

      const j = await r.json();
      const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ||  [happy] أهلاً بك! ;

      res.writeHead(200, {  Content-Type :  application/json; charset=utf-8  });
      res.end(JSON.stringify({ mood:  happy , reply: text }));
    } catch (e) {
      res.writeHead(500, {  Content-Type :  application/json  });
      res.end(JSON.stringify({ error:  server_error  }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sultan server running on port ${PORT}`);
});

 
