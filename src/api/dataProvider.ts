import type {
  Asset,
  AssetSearch,
  Building,
  CurrentUser,
  Floor,
  ListQuery,
  PageResult,
  RecordAction,
  RecordActions,
  Site,
  Space,
  WorkOrder,
  WorkOrderDraft,
  WorkOrderStatus,
  WorkOrderTask,
} from './types';
import type { EstateRaw } from '../estate/types';

/**
 * The provider seam. Every screen talks to this interface and nothing else —
 * no `vibe.*` calls, no `executeAction`, no fetch to Facilio outside src/api.
 * (Enforced by src/__tests__/provider-seam.test.ts.)
 *
 * Two implementations:
 *   - mockProvider  — fixtures, zero org access needed  (?mock=1)
 *   - realProvider  — @facilio/vibe-sdk executeAction against facilio-cmms
 */
export interface DataProvider {
  /** null means signed out (the SDK's representation of a 401). May throw on network failure. */
  getCurrentUser(): Promise<CurrentUser | null>;
  /** Redirects the browser to identity-service (no-op in mock). */
  login(): void;
  logout(): void;
  /**
   * The signed-in person's EMPLOYEE record id, which is a different id space
   * from `CurrentUser.user.uid` and the one work-order assignment points at.
   * Null when the org has no employee row for that address.
   */
  resolveEmployeeId(email: string): Promise<number | null>;

  // ---- portfolio reads (Phase 2.1) ----
  listSites(query?: ListQuery): Promise<PageResult<Site>>;
  listBuildings(): Promise<Building[]>;
  listFloors(): Promise<Floor[]>;
  /**
   * Every space in the org with ancestry attached. Fetched whole (paged
   * underneath) because asset scoping needs the full tree; cache behind
   * react-query, don't call in a loop.
   */
  listAllSpaces(): Promise<Space[]>;
  /** Scope-aware asset search — resolves the scope to space ids internally. */
  searchAssets(search?: AssetSearch): Promise<Asset[]>;
  getAsset(id: number): Promise<Asset | null>;

  // ---- work orders (Phase 2.2–2.4) ----
  listWorkOrders(query?: ListQuery): Promise<PageResult<WorkOrder>>;
  /** WOs raised against these assets (the `resource` lookup), batched internally. */
  listWorkOrdersForAssets(assetIds: number[]): Promise<WorkOrder[]>;
  getWorkOrder(id: number): Promise<WorkOrder | null>;
  listWorkOrderTasks(workOrderId: number): Promise<WorkOrderTask[]>;
  setWorkOrderTaskStatus(workOrderId: number, taskId: number, closed: boolean): Promise<void>;
  /** Append a checklist task to a work order; resolves the new task id. */
  addWorkOrderTask(workOrderId: number, subject: string): Promise<number>;
  /** The status catalogue — workorder.moduleState allowed_values from metadata. */
  getWorkOrderStatuses(): Promise<WorkOrderStatus[]>;
  /** Execute a transition through the status action; `status` is the internal name. */
  changeWorkOrderStatus(workOrderId: number, status: string): Promise<void>;
  /**
   * The buttons the org's published state flow offers on this work order right
   * now. Re-read after EVERY transition — the whole point is that the answer
   * changes with the state, and a stale list offers moves that no longer exist.
   */
  getWorkOrderActions(workOrderId: number): Promise<RecordActions>;
  /** Run one of those buttons. `formData` only for buttons that declare a form. */
  executeWorkOrderAction(
    workOrderId: number,
    action: Pick<RecordAction, 'buttonId' | 'buttonType'>,
    formData?: Record<string, unknown>,
  ): Promise<void>;
  /** Create via the script lane — the create action itself is broken (see scriptFns.ts). */
  createWorkOrder(draft: WorkOrderDraft): Promise<number>;

  // ---- the 3D estate ----
  /**
   * Every record the 3D estate needs, as RAW cmms rows.
   *
   * Raw and not the normalised types on purpose: buildEstate reads tagNumber,
   * localId, manufacturer, model, serialNumber, description, moduleState and
   * the service dates off an asset, plus floorlevel off a floor — all of which
   * toAsset()/toFloor() drop — and list-inspections, which has no domain type.
   * See src/estate/types.ts.
   */
  loadEstate(showRetired?: boolean): Promise<EstateRaw>;
}
