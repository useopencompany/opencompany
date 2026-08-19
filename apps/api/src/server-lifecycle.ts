export type ClosableHttpServer = {
  close(callback: (error?: Error) => void): unknown;
};

export function closeHttpServer(server: ClosableHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
