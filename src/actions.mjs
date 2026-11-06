import { z } from 'zod';

const coordinate = z.number().finite().min(0).max(32768);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const button = z.enum(['left', 'right', 'middle']).default('left');
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: coordinate, y: coordinate, button, clicks: z.number().int().min(1).max(3).default(1) }).strict(),
  z.object({ type: z.literal('move'), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal('drag'), path: z.array(point).min(2).max(100), button }).strict(),
  z.object({ type: z.literal('scroll'), x: coordinate, y: coordinate, deltaX: z.number().finite().min(-10000).max(10000).default(0), deltaY: z.number().finite().min(-10000).max(10000) }).strict(),
  z.object({ type: z.literal('type'), text: z.string().max(20000) }).strict(),
  z.object({ type: z.literal('key'), keys: z.array(z.string().min(1).max(30)).min(1).max(8) }).strict(),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(3000) }).strict()
]);
export const actionsSchema = z.array(actionSchema).min(1).max(32);
export const captureSchema = z.enum(['png', 'jpeg', 'none']).default('none');
export const humanEventsSchema = z.array(z.discriminatedUnion('type',[
  z.object({type:z.literal('pointer'),phase:z.enum(['move','down','up']),x:coordinate,y:coordinate,button}).strict(),
  z.object({type:z.literal('wheel'),x:coordinate,y:coordinate,deltaX:z.number().finite().min(-10000).max(10000).default(0),deltaY:z.number().finite().min(-10000).max(10000)}).strict(),
  z.object({type:z.literal('key'),key:z.string().min(1).max(30),down:z.boolean()}).strict(),
  z.object({type:z.literal('text'),text:z.string().max(20000)}).strict()
])).min(1).max(64);
const ref = z.string().min(1).max(250);
export const semanticActionsSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type:z.literal('fill'),ref,text:z.string().max(20000) }).strict(),
  z.object({ type:z.literal('click'),ref }).strict(),
  z.object({ type:z.literal('select'),ref,value:z.string().max(2000) }).strict(),
  z.object({ type:z.literal('check'),ref,checked:z.boolean() }).strict()
])).min(1).max(32);

export class Lane {
  #tail = Promise.resolve();
  busy = 0;
  drain() { return this.#tail; }
  run(fn) {
    this.busy++;
    const next = this.#tail.then(fn);
    const tracked = next.finally(() => { this.busy--; });
    this.#tail = tracked.catch(() => {});
    return tracked;
  }
}

export function checkCoordinates(actions, size) {
  for (const action of actions) {
    const points = action.path ?? (action.x !== undefined ? [action] : []);
    for (const point of points) {
      if (point.x >= size.width || point.y >= size.height) {
        throw new Error(`Coordinates outside ${size.width}x${size.height} viewport`);
      }
    }
  }
}

export function allowedURL(raw) {
  if (raw === 'about:blank') return raw;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials and about:blank are supported');
  }
  return url.href;
}
