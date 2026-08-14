export interface PlanAssignment {
  /** Plan id — the basename of public/plans/<id>.json. */
  plan: string;
  building: RegExp;
  floor: RegExp;
}

export declare const PLAN_ASSIGNMENTS: PlanAssignment[];
