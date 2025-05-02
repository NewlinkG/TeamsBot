// api/keepalive/index.js
module.exports = async function (context, req) {
    // Respuesta rápida y sin lógica extra
    context.res = {
      status: 200,
      body: "OK"
    };
  };
  