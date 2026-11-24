import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import OAuthProvider from "@cloudflare/workers-oauth-provider";

const BASE = "https://intervals.icu/api/v1";

export class MyMCP extends McpAgent {
  server = new McpServer({ name: "Intervals.icu", version: "1.0.0" });

  private authHeader() {
    return `Basic ${btoa(`API_KEY:${this.env.INTERVALS_API_KEY}`)}`;
  }

  private async icu(path: string, init: RequestInit = {}) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: this.authHeader(), "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`intervals.icu ${res.status}: ${await res.text()}`);
    const text = await res.text();
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, raw: text };
    }
  }

  async init() {
    const athlete = this.env.INTERVALS_ATHLETE_ID;

    this.server.tool(
      "getRecentActivities",
      { days: z.number().optional().describe("Days back, default 14") },
      async ({ days = 14 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/activities?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "getWellness",
      { days: z.number().optional().describe("Days back, default 7") },
      async ({ days = 7 }) => {
        const oldest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/wellness?oldest=${oldest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "listUpcomingEvents",
      { days: z.number().optional().describe("Days ahead, default 14") },
      async ({ days = 14 }) => {
        const today = new Date().toISOString().slice(0, 10);
        const newest = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
        const data = await this.icu(`/athlete/${athlete}/events?oldest=${today}&newest=${newest}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "createWorkout",
      {
        date: z.string().describe("YYYY-MM-DD"),
        name: z.string(),
        type: z.string().describe("Run, Ride, Swim, etc."),
        description: z.string().describe("Structured steps, e.g. '- 10m Z2\\n- 6x800m Z4, 400m Z1 jog\\n- 10m Z2'"),
      },
      async ({ date, name, type, description }) => {
        const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
          && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
          && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

        if (!validDate) {
          throw new Error("Invalid date. Use YYYY-MM-DD.");
        }

        const todayMelbourne = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Australia/Melbourne",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());

        if (date < todayMelbourne) {
          throw new Error("Cannot create a workout in the past.");
        }
        const data = await this.icu(`/athlete/${athlete}/events`, {
          method: "POST",
          body: JSON.stringify({ start_date_local: `${date}T00:00:00`, category: "WORKOUT", type, name, description }),
        });
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.tool(
      "updateWorkout",
      {
        eventId: z.number().describe("Event ID from listUpcomingEvents"),
        date: z.string().optional().describe("YYYY-MM-DD"),
        name: z.string().optional(),
        type: z.string().optional(),
        description: z.string().optional(),
      },
      async ({ eventId, date, name, type, description }) => {
        const existing = await this.icu(`/athlete/${athlete}/events/${eventId}`);

        if (!existing || existing.category !== "WORKOUT") {
          throw new Error("Cannot update: event not found or is not a planned workout.");
        }

        const todayMelbourne = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Australia/Melbourne",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());

        const existingDate = existing.start_date_local?.slice(0, 10);

if (!existingDate || existingDate < todayMelbourne) {
  throw new Error("Cannot update past workouts.");
}

        if (date) {
          const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
            && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
            && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

          if (!validDate || date < todayMelbourne) {
            throw new Error("Invalid date or cannot move a workout into the past.");
          }
        }

        const body: Record<string, unknown> = {};
        if (date) body.start_date_local = `${date}T00:00:00`;
        if (name) body.name = name;
        if (type) body.type = type;
        if (description) body.description = description;

        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });

        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
    this.server.tool(
      "deleteEvent",
      { eventId: z.number().describe("Event ID from listUpcomingEvents") },
      async ({ eventId }) => {
        const existing = await this.icu(`/athlete/${athlete}/events/${eventId}`);

        if (!existing || existing.category !== "WORKOUT") {
          throw new Error("Cannot delete: event not found or is not a planned workout.");
        }

        const todayMelbourne = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Australia/Melbourne",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());

        const existingDate = existing.start_date_local?.slice(0, 10);

        if (!existingDate || existingDate <= todayMelbourne) {
          throw new Error("Cannot delete past or same-day workouts.");
        }

        const data = await this.icu(`/athlete/${athlete}/events/${eventId}`, {
          method: "DELETE",
        });

        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  }
}

function loginPage(state: string, error: string) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Intervals.icu MCP</title>
  <body style="font-family:system-ui;max-width:20rem;margin:4rem auto">
  <h2>Intervals.icu MCP</h2>
  <p style="color:#c00">${error}</p>
  <form method="post">
    <input type="hidden" name="state" value="${state}">
    <input type="password" name="password" placeholder="Password" autofocus
           style="width:100%;padding:.5rem;margin-bottom:.5rem">
    <button style="width:100%;padding:.5rem">Authorize</button>
  </form></body>`;
}

const defaultHandler = {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const html = { "content-type": "text/html;charset=utf-8" };

    if (request.method === "GET") {
      const info = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      return new Response(loginPage(btoa(JSON.stringify(info)), ""), { headers: html });
    }

    const body = await request.formData();
    const state = String(body.get("state") ?? "");
    if (String(body.get("password")) !== env.MCP_PASSWORD) {
      return new Response(loginPage(state, "Wrong password"), { status: 401, headers: html });
    }

    const info = JSON.parse(atob(state));
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: info,
      userId: "owner",
      metadata: {},
      scope: info.scope ?? [],
      props: {},
    });
    return Response.redirect(redirectTo, 302);
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MyMCP.serve("/mcp") as any,
  defaultHandler: defaultHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
