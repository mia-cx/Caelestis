import { DurableObject } from 'cloudflare:workers'
import {
  type MeasuredD1Operation,
  measureD1Usage,
  mergeD1Usage,
} from '../../metrics/request-metrics.js'

/** The names of `Target`'s methods. */
type MethodName<Target> = {
  [K in keyof Target]-?: Target[K] extends (...args: never[]) => unknown ? K : never
}[keyof Target] &
  string

/** A method whose reply also carries the D1 work it did. */
type Measured<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<MeasuredD1Operation<Awaited<R>>>
  : never

/** A Durable Object whose RPC methods forward to the target its constructor builds. */
export abstract class ForwardingObject<Target> extends DurableObject<Env> {
  protected abstract readonly target: Target
}

const callMethod = (holder: object, name: string, args: unknown[]): unknown => {
  const method: unknown = Reflect.get(holder, name)
  if (typeof method !== 'function') throw new TypeError(`${name} is not a method`)
  return Reflect.apply(method, holder, args)
}

/**
 * A base class for a Durable Object that serves `names` of its `target` over RPC. DO RPC calls
 * only prototype methods, so each name becomes one. A `measured` method replies with the D1 work
 * it did, which `forwardingClient` credits to the calling request's metric.
 */
export const forwardingObject =
  <Target extends object>() =>
  <
    const Names extends readonly MethodName<Target>[],
    const MeasuredNames extends readonly Names[number][] = readonly [],
  >(
    names: Names,
    measured?: MeasuredNames,
  ) => {
    abstract class Forwarding extends ForwardingObject<Target> {}
    for (const name of names) {
      const isMeasured = measured?.includes(name) === true
      Object.defineProperty(Forwarding.prototype, name, {
        configurable: true,
        writable: true,
        value(this: Forwarding, ...args: unknown[]) {
          const call = async () => callMethod(this.target, name, args)
          return isMeasured ? measureD1Usage(call) : callMethod(this.target, name, args)
        },
      })
    }
    // The loop installed exactly these methods; TypeScript cannot follow a loop over names.
    return Forwarding as unknown as abstract new (
      ctx: DurableObjectState,
      env: Env,
    ) => ForwardingObject<Target> &
      Omit<Pick<Target, Names[number]>, MeasuredNames[number]> & {
        [K in MeasuredNames[number]]: Measured<Target[K]>
      }
  }

/**
 * A Durable Object stub as the target its object forwards `names` to, crediting the D1 work of
 * `measured` calls to this request's metric. A stub belongs to the request that created it, so
 * build one client per request.
 */
export const forwardingClient =
  <Target extends object>() =>
  <const Names extends readonly MethodName<Target>[]>(
    stub: object,
    names: Names,
    measured: readonly Names[number][],
  ): Pick<Target, Names[number]> => {
    const methods = names.map((name) => [
      name,
      measured.includes(name)
        ? async (...args: unknown[]) => {
            // `forwardingObject` wraps exactly these replies in `measureD1Usage`.
            const result = (await callMethod(stub, name, args)) as MeasuredD1Operation<unknown>
            mergeD1Usage(result.usage)
            if (!result.success) throw result.error
            return result.value
          }
        : (...args: unknown[]) => callMethod(stub, name, args),
    ])
    // Every name now maps to a forwarder; TypeScript cannot follow `fromEntries` over names.
    return Object.fromEntries(methods) as Pick<Target, Names[number]>
  }
