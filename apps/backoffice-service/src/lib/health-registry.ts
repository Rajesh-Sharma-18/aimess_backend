import type {
  InfraHealth,
  ServiceHealth,
} from "../types/system-health.types.js";

/**
 * Central registration point for System Health. A component (service or
 * infrastructure dependency) registers itself ONCE with a `key`/`name` and an
 * optional probe; `/system-health` iterates the registry instead of a
 * hardcoded list, so adding a new component never touches the controller,
 * service, or response builder.
 */

export interface ServiceProbeDef {
  key: string;
  name: string;
  /** Omit when no live probe exists yet — reported `monitored:false`/`unknown`. */
  probe?: () => Promise<ServiceHealth>;
}

export interface InfraProbeDef {
  key: string;
  name: string;
  probe: () => Promise<InfraHealth>;
}

class HealthRegistry<T extends { key: string }> {
  private readonly entries = new Map<string, T>();

  protected add(def: T): void {
    if (this.entries.has(def.key)) {
      throw new Error(`health registry: "${def.key}" is already registered`);
    }
    this.entries.set(def.key, def);
  }

  protected all(): T[] {
    return [...this.entries.values()];
  }
}

/** Stores registered service probes; nothing else. */
export class HealthServiceRegistry extends HealthRegistry<ServiceProbeDef> {
  registerService(def: ServiceProbeDef): void {
    this.add(def);
  }

  getServices(): ServiceProbeDef[] {
    return this.all();
  }
}

/** Stores registered infrastructure probes; nothing else. */
export class HealthInfrastructureRegistry extends HealthRegistry<InfraProbeDef> {
  registerInfrastructure(def: InfraProbeDef): void {
    this.add(def);
  }

  getInfrastructure(): InfraProbeDef[] {
    return this.all();
  }
}

export const healthServiceRegistry = new HealthServiceRegistry();
export const healthInfrastructureRegistry = new HealthInfrastructureRegistry();
