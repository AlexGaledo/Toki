import { actorOf, recordAudit } from '../services/AuditLog.js';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ClientEventSchema, WS_PING_MS, type ServerEvent } from '@pocketrocket/shared';
import { MAX_WS_BYTES } from './body.js';
import { deviceIdOf } from './guard.js';
import { events } from '../events.js';
import type { Repos } from '../db/repos.js';
import type { RoomRouter } from '../rooms/RoomRouter.js';
import { SIGN_IN_MESSAGE, type PermissionBroker } from '../permissions/PermissionBroker.js';
import type { MediaStore } from '../services/MediaStore.js';
import type { FormBroker } from '../services/FormBroker.js';
import type { SettingsStore } from '../services/SettingsStore.js';

export function attachWs(
  _server: Server,
  deps: {
    media?: MediaStore;
    forms?: FormBroker;
    repos: Repos; router: RoomRouter; broker: PermissionBroker; settings: SettingsStore;
    signedIn?: (req: IncomingMessage) => boolean;
    pingMs?: number;
  },
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_BYTES });
  const send = (ws: WebSocket, ev: ServerEvent) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  };

  events.onEvent((ev) => {
    for (const c of wss.clients) send(c, ev);
  });

  const pinger = setInterval(() => {
    const ev: ServerEvent = { type: 'ping', t: Date.now() };
    for (const c of wss.clients) send(c, ev);
  }, deps.pingMs ?? WS_PING_MS);
  pinger.unref();
  wss.on('close', () => clearInterval(pinger));

  wss.on('connection', (ws, req?: IncomingMessage) => {
    const device = req ? deviceIdOf(req) : null;
    const signedIn = () => !device && !!req && !!deps.signedIn?.(req);
    send(ws, { type: 'hello', bots: deps.repos.listBots(), rooms: deps.repos.listRooms(), botStates: deps.router.botStates(), settings: deps.settings.get(), principal: device ? 'device' : 'hub', signedIn: signedIn(), openApprovals: deps.repos.openApprovals() });
    ws.on('message', (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return send(ws, { type: 'error', message: 'Invalid JSON' });
      }
      const parsed = ClientEventSchema.safeParse(data);
      if (!parsed.success) return send(ws, { type: 'error', message: 'Bad event: ' + parsed.error.issues.map((i) => i.message).join(', ') });
      const ev = parsed.data;
      try {
        if (ev.type === 'pong') return;
        if (ev.type === 'message.send') {
          try {
            const refs = ev.attachments ?? [];
            if (refs.length) {
              const why = deps.media ? deps.media.checkAttachments(refs) : 'This hub cannot take pictures';
              if (why) throw new Error(why);
            }
            deps.router.onUserMessage(ev.roomId, ev.text, ev.clientMsgId, refs.length ? [...new Set(refs)] : undefined, ev.mode);
          } catch (e) {
            return send(ws, { type: 'error', message: (e as Error).message ?? String(e), ...(ev.clientMsgId ? { context: ev.clientMsgId } : {}) });
          }
        }
        else if (ev.type === 'approval.decide') {
          if (device && ev.decision === 'always') return send(ws, { type: 'error', message: '"Always allow" can only be granted from the desktop app', context: ev.approvalId });
          const card = deps.repos.db.get('SELECT tool_name, bot_id FROM approvals WHERE id=?', ev.approvalId);
          const who = req ? actorOf(req) : null;
          const isSignedIn = signedIn();
          if (ev.decision !== 'deny' && !isSignedIn && deps.broker.needsSignIn(ev.approvalId)) {
            if (who && card) recordAudit(deps.repos.db, who, 'approval.refused_not_signed_in', ev.approvalId, String(card.tool_name) + ' by bot ' + String(card.bot_id));
            return send(ws, { type: 'error', message: SIGN_IN_MESSAGE, context: ev.approvalId });
          }
          const answered = deps.broker.resolve(ev.approvalId, ev.decision, { device: !!device, signedIn: isSignedIn });
          if (answered && who && card) recordAudit(deps.repos.db, who, 'approval.' + ev.decision, ev.approvalId, String(card.tool_name) + ' by bot ' + String(card.bot_id));
          if (!answered) send(ws, { type: 'error', message: 'Approval no longer pending', context: ev.approvalId });
        } else if (ev.type === 'form.submit') {
          const why = deps.forms ? deps.forms.submit(ev.formId, ev.answers) : 'This hub cannot take form answers';
          if (why) send(ws, { type: 'error', message: why, context: ev.formId });
        } else if (ev.type === 'form.cancel') {
          if (!deps.forms?.cancel(ev.formId)) send(ws, { type: 'error', message: 'This form is no longer waiting for an answer.', context: ev.formId });
        } else if (ev.type === 'turn.interrupt') {
          if (!deps.router.interrupt(ev.turnId)) send(ws, { type: 'error', message: 'Turn not active', context: ev.turnId });
        } else if (ev.type.startsWith('queue.')) {
          const context = 'journalId' in ev ? ev.journalId : 'botId' in ev ? ev.botId : undefined;
          try {
            if (ev.type === 'queue.cancel') deps.router.cancelQueued(ev.journalId);
            else if (ev.type === 'queue.edit') deps.router.editQueued(ev.journalId, ev.text);
            else if (ev.type === 'queue.sendNow') deps.router.sendNow(ev.roomId, ev.botId);
            else if (ev.type === 'queue.pause') deps.router.setQueuePaused(ev.roomId, ev.botId, ev.paused);
          } catch (e) {
            return send(ws, { type: 'error', message: (e as Error).message ?? String(e), ...(context ? { context } : {}) });
          }
        }
      } catch (e) {
        send(ws, { type: 'error', message: (e as Error).message ?? String(e) });
      }
    });
  });
  return wss;
}
