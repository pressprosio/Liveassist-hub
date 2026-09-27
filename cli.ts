/**
 * Admin commands. Run inside the container, e.g.:
 *   docker compose exec hub npm run site:create -- --name "PressPros" --url https://presspros.io
 */
import { createInterface } from 'node:readline/promises';
import { config } from './config.js';
import { migrate, closeDb } from './db.js';
import { createSite, listSites, rotateSecret, setActive } from './sites.js';
import { createAgent, listAgents, removeAgent, resetPassword } from './agents.js';
import { randomPassword } from './crypto.js';

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function need(a: Record<string, string | boolean>, key: string, example: string): string {
  const v = a[key];
  if (typeof v !== 'string' || !v.trim()) {
    console.error(`Missing --${key}. Example: ${example}`);
    process.exit(1);
  }
  return v.trim();
}

const HELP = `LiveAssist hub commands (prefix with: docker compose exec hub)

  npm run site:create -- --name "PressPros" --url https://presspros.io [--id presspros]
  npm run site:list
  npm run site:rotate-secret -- --id presspros
  npm run site:disable -- --id presspros
  npm run site:enable -- --id presspros

  npm run agent:create -- --email you@presspros.io --name "Stacy" [--admin] [--password "..."]
  npm run agent:list
  npm run agent:reset-password -- --email you@presspros.io [--password "..."]
  npm run agent:remove -- --email someone@presspros.io
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (!cmd || cmd === 'help' || a.help) {
    console.log(HELP);
    return;
  }
  config();
  await migrate();

  switch (cmd) {
    case 'site:create': {
      const name = need(a, 'name', '--name "PressPros"');
      const url = need(a, 'url', '--url https://presspros.io');
      const { id, secret } = await createSite(name, url, typeof a.id === 'string' ? a.id : undefined);
      console.log(`
Site created. Paste these into WordPress → LiveAssist → Settings → Connection:

  Hub URL:     ${config().publicUrl}
  Site ID:     ${id}
  Site secret: ${secret}

The secret is shown only once. If you lose it, run site:rotate-secret.
`);
      break;
    }
    case 'site:list': {
      const sites = await listSites();
      if (!sites.length) console.log('No sites yet. Create one with site:create.');
      for (const s of sites) console.log(`${s.active ? '●' : '○'} ${s.id.padEnd(24)} ${s.url.padEnd(36)} ${s.plugin ? `plugin ${s.plugin}` : 'WordPress not connected yet'}`);
      break;
    }
    case 'site:rotate-secret': {
      const id = need(a, 'id', '--id presspros');
      const secret = await rotateSecret(id);
      if (!secret) throw new Error(`No site with ID "${id}".`);
      console.log(`\nNew secret for ${id}:\n\n  ${secret}\n\nPaste it into WordPress now. The old secret has stopped working.\n`);
      break;
    }
    case 'site:disable':
    case 'site:enable': {
      const id = need(a, 'id', '--id presspros');
      if (!(await setActive(id, cmd === 'site:enable'))) throw new Error(`No site with ID "${id}".`);
      console.log(`${id} ${cmd === 'site:enable' ? 'enabled' : 'disabled'}.`);
      break;
    }
    case 'agent:create': {
      const email = need(a, 'email', '--email you@presspros.io');
      const name = need(a, 'name', '--name "Stacy"');
      const password = typeof a.password === 'string' ? a.password : randomPassword();
      await createAgent(email, name, password, a.admin ? 'admin' : 'agent', !a.password);
      console.log(`\nTeam member created.\n\n  Sign in at: ${config().publicUrl}/console/ or in the LiveAssist app\n  Email:      ${email}\n  Password:   ${a.password ? '(the one you chose)' : `${password}  (temporary: they choose their own at first sign-in)`}\n`);
      break;
    }
    case 'agent:list': {
      for (const ag of await listAgents()) console.log(`${ag.role.padEnd(6)} ${ag.email.padEnd(32)} ${ag.name}`);
      break;
    }
    case 'agent:reset-password': {
      const email = need(a, 'email', '--email you@presspros.io');
      let password = typeof a.password === 'string' ? a.password : '';
      if (!password && process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        password = (await rl.question('New password (leave empty to generate one): ')).trim();
        rl.close();
      }
      const generated = !password;
      if (generated) password = randomPassword();
      if (!(await resetPassword(email, password, generated))) throw new Error(`No team member with email ${email}.`);
      console.log(`Password updated${generated ? `: ${password}  (temporary: they choose their own at next sign-in)` : ''}. They have been signed out everywhere.`);
      break;
    }
    case 'agent:remove': {
      const email = need(a, 'email', '--email someone@presspros.io');
      if (!(await removeAgent(email))) throw new Error(`No team member with email ${email}.`);
      console.log(`${email} removed.`);
      break;
    }
    default:
      console.log(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`Error: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
