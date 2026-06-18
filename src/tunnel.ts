import { readFileSync } from "fs";
import { createServer, Server, AddressInfo } from "net";
import { Client as SshClient, ConnectConfig } from "ssh2";

export interface TunnelConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** Path to a private key file (preferred over password) */
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  sshPassword?: string;
  /** Remote host as seen from the SSH server (default: localhost) */
  remoteHost: string;
  remotePort: number;
}

export interface Tunnel {
  /** Local port the tunnel is listening on — point pg Pool here */
  localPort: number;
  close(): void;
}

/**
 * Read SSH tunnel config from environment variables.
 * Returns null when PG_SSH_HOST is not set (no tunnel needed).
 */
export function getTunnelConfig(pgHost: string, pgPort: number): TunnelConfig | null {
  const sshHost = process.env.PG_SSH_HOST;
  if (!sshHost) return null;

  const sshUser = process.env.PG_SSH_USER;
  if (!sshUser) {
    throw new Error("PG_SSH_HOST is set but PG_SSH_USER is missing");
  }

  const privateKeyPath = process.env.PG_SSH_PRIVATE_KEY;
  const sshPassword    = process.env.PG_SSH_PASSWORD;

  if (!privateKeyPath && !sshPassword) {
    throw new Error(
      "SSH tunnel requires either PG_SSH_PRIVATE_KEY (path to key file) or PG_SSH_PASSWORD"
    );
  }

  return {
    sshHost,
    sshPort: process.env.PG_SSH_PORT ? parseInt(process.env.PG_SSH_PORT, 10) : 22,
    sshUser,
    privateKeyPath,
    privateKeyPassphrase: process.env.PG_SSH_KEY_PASSPHRASE,
    sshPassword,
    // The target postgres host/port as the SSH server sees it
    remoteHost: process.env.PG_SSH_REMOTE_HOST ?? pgHost,
    remotePort: pgPort,
  };
}

/**
 * Open an SSH tunnel and return the local port to connect through.
 *
 * Architecture:
 *   pg Pool → localhost:localPort → SSH server → remoteHost:remotePort (postgres)
 */
export function openTunnel(cfg: TunnelConfig): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const sshClient = new SshClient();

    const connectCfg: ConnectConfig = {
      host:     cfg.sshHost,
      port:     cfg.sshPort,
      username: cfg.sshUser,
      readyTimeout: 15000,
    };

    if (cfg.privateKeyPath) {
      connectCfg.privateKey  = readFileSync(cfg.privateKeyPath);
      connectCfg.passphrase  = cfg.privateKeyPassphrase;
    } else {
      connectCfg.password = cfg.sshPassword;
    }

    // Local TCP server that forwards each socket through the SSH channel
    const localServer: Server = createServer((localSocket) => {
      sshClient.forwardOut(
        "127.0.0.1", 0,
        cfg.remoteHost,
        cfg.remotePort,
        (err, channel) => {
          if (err) {
            localSocket.destroy(err);
            return;
          }
          localSocket.pipe(channel);
          channel.pipe(localSocket);
          localSocket.on("close", () => channel.end());
          channel.on("close", () => localSocket.destroy());
        }
      );
    });

    // Bind to an OS-assigned ephemeral port
    localServer.listen(0, "127.0.0.1", () => {
      const { port: localPort } = localServer.address() as AddressInfo;

      process.stderr.write(
        `SSH tunnel: 127.0.0.1:${localPort} → ${cfg.sshHost}:${cfg.sshPort} → ${cfg.remoteHost}:${cfg.remotePort}\n`
      );

      resolve({
        localPort,
        close() {
          localServer.close();
          sshClient.end();
        },
      });
    });

    localServer.on("error", (err) => {
      sshClient.end();
      reject(err);
    });

    sshClient.on("ready", () => {
      // Local server is already listening; nothing extra needed here
    });

    sshClient.on("error", (err) => {
      localServer.close();
      reject(new Error(`SSH connection failed: ${err.message}`));
    });

    sshClient.connect(connectCfg);
  });
}
