import type { KeyEvent } from './keys.js';

type Widget = { handleKey(key: KeyEvent): any; state: any };

export interface FlowStep {
  id: string;
  label: string;
  createWidget: (accumulated: Record<string, any>) => Widget;
  condition?: (accumulated: Record<string, any>) => boolean;
  onResult: (event: any, accumulated: Record<string, any>) => void;
}

export type FlowEvent =
  | { type: 'step-complete'; stepId: string; nextStepId: string }
  | { type: 'flow-complete'; results: Record<string, any> }
  | { type: 'flow-cancelled' }
  | { type: 'widget-event'; event: any }
  | { type: 'none' };

export class FlowEngine {
  private steps: FlowStep[];
  private currentIndex: number;
  private accumulated: Record<string, any>;
  private currentWidget: Widget | null;
  private complete: boolean;

  constructor(steps: FlowStep[], initialState?: Record<string, any>) {
    this.steps = steps;
    this.accumulated = initialState ? { ...initialState } : {};
    this.complete = false;
    this.currentIndex = -1;
    this.currentWidget = null;
    this.advanceToNext();
  }

  handleKey(key: KeyEvent): FlowEvent {
    if (this.complete || !this.currentWidget) return { type: 'none' };

    const event = this.currentWidget.handleKey(key);

    // Cancel
    if (event.type === 'cancel') {
      return { type: 'flow-cancelled' };
    }

    // Completion events vary by widget type
    if (event.type === 'submit' || event.type === 'select' || event.type === 'answer') {
      const step = this.steps[this.currentIndex];
      step.onResult(event, this.accumulated);
      const prevStepId = step.id;

      this.advanceToNext();

      if (this.complete) {
        return { type: 'flow-complete', results: this.accumulated };
      }

      return { type: 'step-complete', stepId: prevStepId, nextStepId: this.steps[this.currentIndex].id };
    }

    return { type: 'widget-event', event };
  }

  getCurrentState(): { stepId: string; widget: Widget; progress: number } {
    const step = this.steps[this.currentIndex];
    return {
      stepId: step?.id ?? '',
      widget: this.currentWidget!,
      progress: this.currentIndex / this.steps.length,
    };
  }

  isComplete(): boolean {
    return this.complete;
  }

  getResults(): Record<string, any> {
    return this.accumulated;
  }

  private advanceToNext(): void {
    this.currentIndex++;

    // Skip steps whose conditions are false
    while (this.currentIndex < this.steps.length) {
      const step = this.steps[this.currentIndex];
      if (step.condition && !step.condition(this.accumulated)) {
        this.currentIndex++;
        continue;
      }
      // Found a valid step
      this.currentWidget = step.createWidget(this.accumulated);
      return;
    }

    // No more steps
    this.complete = true;
    this.currentWidget = null;
  }
}
