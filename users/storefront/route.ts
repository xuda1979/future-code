import { env } from 'cloudflare:workers';
// @ts-expect-error commerce modules are portable JavaScript tested with Node.
import { handleRequest } from '../../../lib/users/commerce/service.mjs';
import manifest from '../../../lib/users/releases.json';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handleRequest(request, env, manifest); }
export async function POST(request: Request) { return handleRequest(request, env, manifest); }
