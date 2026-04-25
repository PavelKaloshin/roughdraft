import net from "node:net";

const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];

function canListenOnPort(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.unref();

    server.on("error", (error) => {
      if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") {
        resolve(false);
        return;
      }

      if (error.code === "EADDRINUSE") {
        reject(error);
        return;
      }

      reject(error);
    });

    server.listen(port, host, () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(true);
      });
    });
  });
}

export async function findAvailableLoopbackPort(preferredPort) {
  try {
    const results = await Promise.all(
      LOOPBACK_HOSTS.map((host) => canListenOnPort(preferredPort, host)),
    );

    if (results.some(Boolean)) {
      return preferredPort;
    }
  } catch (error) {
    const errorCode = error?.code;
    if (errorCode !== "EADDRINUSE") {
      throw error;
    }
  }

  return findAvailableLoopbackPort(preferredPort + 1);
}
