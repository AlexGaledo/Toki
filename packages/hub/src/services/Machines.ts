import {
  DEFAULT_MACHINE_POLICY, MACHINE_POLICIES, PC_MACHINE_ID, VPS_MACHINE_ID,
  type MachineInfo, type MachinePolicy,
} from '@pocketrocket/shared';
import type { Db } from '../db/db.js';
import type { PcRunner } from './PcRunner.js';

export class Machines {
  constructor(private db: Db, private pc?: PcRunner, private now: () => number = Date.now) {}

  static readonly SETTABLE: readonly string[] = [PC_MACHINE_ID];

  policy(id: string): MachinePolicy {
    if (id === VPS_MACHINE_ID) return 'always';
    const r = this.db.get<{ policy: string }>('SELECT policy FROM machine_policies WHERE machine=?', id);
    return (MACHINE_POLICIES as readonly string[]).includes(r?.policy ?? '') ? (r!.policy as MachinePolicy) : DEFAULT_MACHINE_POLICY;
  }

  setPolicy(id: string, policy: MachinePolicy): boolean {
    if (!Machines.SETTABLE.includes(id)) return false;
    this.db.run(
      'INSERT INTO machine_policies (machine, policy, updated_at) VALUES (?,?,?) ON CONFLICT(machine) DO UPDATE SET policy=excluded.policy, updated_at=excluded.updated_at',
      id, policy, this.now(),
    );
    return true;
  }

  list(): MachineInfo[] {
    const paired = !!this.pc?.isPaired();
    return [
      { id: VPS_MACHINE_ID, label: 'Your own computer', kind: 'own', online: true, paired: true, policy: this.policy(VPS_MACHINE_ID) },
      { id: PC_MACHINE_ID, label: "Owner's PC", kind: 'pc', online: paired && !!this.pc?.online(), paired, policy: this.policy(PC_MACHINE_ID) },
    ];
  }

  get(id: string): MachineInfo | undefined {
    return this.list().find((m) => m.id === id);
  }
}
