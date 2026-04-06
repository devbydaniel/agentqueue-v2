import { Injectable, Logger } from '@nestjs/common';

/**
 * Tracks `AbortController` instances for in-flight flow runs so they can be
 * cancelled by an external abort request.
 *
 * This is intentionally an in-memory service (not a repository): `AbortController`
 * is bound to the running process and cannot be persisted. When a flow run is
 * started its controller is registered here; when someone calls abort we signal
 * the controller and drop the reference.
 */
@Injectable()
export class FlowAbortTrackerService {
  private readonly logger = new Logger(FlowAbortTrackerService.name);
  private readonly controllers = new Map<string, AbortController>();

  track(flowRunId: string, controller: AbortController): void {
    this.controllers.set(flowRunId, controller);
  }

  /**
   * Signal abort on the tracked controller and remove it.
   * Returns true if a controller was found and aborted, false otherwise.
   */
  abort(flowRunId: string): boolean {
    const controller = this.controllers.get(flowRunId);
    if (!controller) {
      this.logger.warn(`No abort controller found for flow run ${flowRunId}`);
      return false;
    }
    this.logger.log(`Aborting flow run ${flowRunId}`);
    controller.abort();
    this.controllers.delete(flowRunId);
    return true;
  }
}
