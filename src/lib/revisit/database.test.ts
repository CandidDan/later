import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { createReturnController } from "./return-controller";
import { randomUUID } from "node:crypto";
import { disposableDatabase } from "./database-fixture";

const fixture = disposableDatabase();
const { sql, args } = fixture;
const owner = "99999999-9999-4999-8999-999999999919";
const capture = "99999999-9999-4999-8999-999999999920";
const recall = `select public.research_record_recall('${capture}','remembered','before exposure')`;
const expose = `select public.revisit_expose('${capture}')`;
const auth = `set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false);`;
function session(input: string) {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  const timeout = setTimeout(() => child.kill(), 10000);
  child.stderr.resume();
  child.stdin.end(input);
  return new Promise<string>((resolve, reject) => {
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", code => {
      clearTimeout(timeout);
      if (code === 0) resolve(output.trim());
      else reject(new Error("Disposable database session failed"));
    });
  });
}
async function waitForSleep() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (sql("select count(*) from pg_stat_activity where application_name='later0019-race' and wait_event='PgSleep'") === "1") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Lock holder did not reach barrier");
}
describe("0019 real database boundaries", () => {
  beforeAll(async () => {
    await fixture.start();
    sql(`insert into auth.users(id,email) values('${owner}','race0019@example.test');
      insert into public.captures(id,user_id,capture_channel,captured_at) values('${capture}','${owner}','email',now());
      insert into public.capture_analyses(capture_id,analysis_type,status,input_snapshot,result,model_id,prompt_version,pipeline_version)
        select '${capture}','intent','succeeded','{}','{}','test','v1','v1' from generate_series(1,2);`);
  }, 420000);
  afterAll(() => { fixture.stop(); });
  it("AC5 exposure wins the lock: concurrent stale recall writes zero multi-run rows", async () => {
    const first = session(`set application_name='later0019-race'; begin; ${auth} ${expose}; select pg_sleep(1); commit;`);
    await waitForSleep(); const second = session(`${auth} ${recall};`);
    await first; expect(await second).toContain('"status": "exposed"');
    expect(sql(`select count(*) from public.capture_evaluations where capture_id='${capture}'`)).toBe("0");
    expect(sql(`select count(*) from public.capture_revisit_state where capture_id='${capture}' and first_exposed_at is not null`)).toBe("1");
  }, 15000);
  it("AC5 recall wins the lock: every run commits before waiting exposure, persisted recall resumes", async () => {
    sql(`delete from public.capture_revisit_state where capture_id='${capture}'`);
    const first = session(`set application_name='later0019-race'; begin; ${auth} ${recall}; select pg_sleep(1); commit;`);
    await waitForSleep(); const second = session(`${auth} ${expose};`);
    expect(await first).toContain('"runs": 2'); expect(await second).toMatch(/t$/);
    expect(sql(`select count(*) from public.capture_evaluations where capture_id='${capture}'`)).toBe("2");
    expect(sql(`select bool_and(e.recalled_at <= s.first_exposed_at) from public.capture_evaluations e join public.capture_revisit_state s using(capture_id) where capture_id='${capture}'`)).toBe("t");
    expect(sql(`${auth} ${recall}`)).toContain('"repeated": true');
  }, 15000);
  it("AC5 invalid recall rolls back all run rows", () => {
    sql(`delete from public.capture_evaluations where capture_id='${capture}'; delete from public.capture_revisit_state where capture_id='${capture}'`);
    expect(() => sql(`${auth} select public.research_record_recall('${capture}','invalid',null)`)).toThrow();
    expect(sql(`select count(*) from public.capture_evaluations where capture_id='${capture}'`)).toBe("0");
  });
  it("AC2 migration rerun preserves durable first exposure", () => {
    sql(`${auth} ${expose}`); const first = sql(`select first_exposed_at from public.capture_revisit_state where capture_id='${capture}'`);
    sql(readFileSync("supabase/migrations/20261006090000_capture_revisit_state.sql", "utf8"));
    expect(sql(`select first_exposed_at from public.capture_revisit_state where capture_id='${capture}'`)).toBe(first);
  });
  it("AC1-AC4/AC6-AC7 real database ordering, durability, idempotence, research and RLS: 45 pgTAP outcomes", () => {
    const output = sql(readFileSync("supabase/tests/database/capture_revisit_state.test.sql", "utf8"));
    expect(output).not.toContain("not ok"); expect(output).toContain("1..45");
    expect(output.split("\n").filter(line => /^ok \d+ - /.test(line))).toHaveLength(45);
  });
  it("0020 AC4 controller actions survive reload against real PostgreSQL without automatic replacement", async () => {
    const user = randomUUID();
    const ids = Array.from({ length: 4 }, () => randomUUID());
    sql(`insert into auth.users(id,email) values('${user}','return0020@example.test');`);
    for (const id of ids) sql(`insert into public.captures(id,user_id,capture_channel,captured_at) values('${id}','${user}','email',now()-interval '10 days');`);
    const asUser = `set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`;
    const calls: string[] = [];
    // Transport bridge only: selection, events and durable state all execute the real RPCs.
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input); calls.push(path);
      if (path.endsWith('/batch')) {
        const selected = JSON.parse(sql(`${asUser} select coalesce(json_agg(id),'[]'::json) from public.revisit_batch() as id;`).split('\n').at(-1)!);
        return Response.json({ cards: selected.map((captureId: string) => ({ captureId })) });
      }
      const captureId = path.split('/').at(-1)!;
      const { action, requestId } = JSON.parse(String(init?.body));
      const outcome = JSON.parse(sql(`${asUser} select public.revisit_action('${captureId}','${requestId}','${action}',null);`).split('\n').at(-1)!);
      return Response.json(outcome);
    };
    const page = createReturnController(fetcher); await page.session('synthetic-token');
    expect(page.snapshot().cards).toHaveLength(3);
    const [deferred, consumed] = page.snapshot().cards;
    await page.act(deferred.captureId, 'defer'); await page.act(consumed.captureId, 'consume');
    expect(page.snapshot().cards).toHaveLength(1); expect(calls.filter(path => path.endsWith('/batch'))).toHaveLength(1);
    const reloaded = createReturnController(fetcher); await reloaded.session('synthetic-token');
    expect(reloaded.snapshot().cards.map(card => card.captureId)).not.toContain(deferred.captureId);
    expect(reloaded.snapshot().cards.map(card => card.captureId)).not.toContain(consumed.captureId);
    expect(sql(`select count(*) from public.capture_revisit_events where user_id='${user}'`)).toBe('2');
    expect(sql(`select deferred_until > now() + interval '6 days' from public.capture_revisit_state where capture_id='${deferred.captureId}'`)).toBe('t');
    await page.load(); expect(calls.filter(path => path.endsWith('/batch'))).toHaveLength(3);
  });

});
