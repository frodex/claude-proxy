import type { KeyEvent, WidgetFieldState } from './keys.js';

type Widget = { handleKey(key: KeyEvent): any; state: any };

export interface FlowStep {
  id: string;
  label: string;
  createWidget: (accumulated: Record<string, any>) => Widget;
  condition?: (accumulated: Record<string, any>) => boolean;
  onResult: (event: any, accumulated: Record<string, any>) => void;
  displayValue?: (accumulated: Record<string, any>) => string;
  required?: boolean;
}

export interface FlowStepSummary {
  id: string;
  label: string;
  fieldState: WidgetFieldState;
  value?: string;
}

export type FlowEvent =
  | { type: 'step-complete'; stepId: string; nextStepId: string }
  | { type: 'flow-complete'; results: Record<string, any> }
  | { type: 'flow-cancelled' }
  | { type: 'mode-change'; mode: 'navigate' | 'edit' }
  | { type: 'widget-event'; event: any }
  | { type: 'none' };

export class FlowEngine {
  private steps: FlowStep[];
  private currentIndex: number;
  private accumulated: Record<string, any>;
  private currentWidget: Widget | null;
  private complete: boolean;
  private mode: 'legacy' | 'navigate' | 'edit' = 'legacy';
  private completedSteps: Set<number> = new Set();

  constructor(steps: FlowStep[], initialState?: Record<string, any>) {
    this.steps = steps;
    this.accumulated = initialState ? { ...initialState } : {};
    this.complete = false;
    this.currentIndex = -1;
    this.currentWidget = null;
    this.advanceToNext();
  }

  handleKey(key: KeyEvent): FlowEvent {
    if (this.complete) return { type: 'none' };
    if (this.mode === 'legacy') return this.handleLegacyKey(key);
    if (this.mode === 'navigate') return this.handleNavigateKey(key);
    return this.handleEditKey(key);
  }

  private handleLegacyKey(key: KeyEvent): FlowEvent {
    if (!this.currentWidget) return { type: 'none' };

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

  private handleNavigateKey(key: KeyEvent): FlowEvent {
    if (key.key === 'Up') {
      const prev = this.findNextVisible(this.currentIndex, -1);
      if (prev !== this.currentIndex) this.currentIndex = prev;
      return { type: 'none' };
    }
    if (key.key === 'Down') {
      const next = this.findNextVisible(this.currentIndex, 1);
      if (next !== this.currentIndex) this.currentIndex = next;
      return { type: 'none' };
    }
    if (key.key === 'Enter') {
      const step = this.steps[this.currentIndex];
      if (!step) return { type: 'none' };
      if (step.condition && !step.condition(this.accumulated)) return { type: 'none' };
      this.currentWidget = step.createWidget(this.accumulated);
      this.mode = 'edit';
      return { type: 'mode-change', mode: 'edit' };
    }
    if (key.key === 's' || key.key === 'S') {
      return this.trySubmit();
    }
    if (key.key === 'Escape' || key.key === 'CtrlC') {
      return { type: 'flow-cancelled' };
    }
    return { type: 'none' };
  }

  private handleEditKey(key: KeyEvent): FlowEvent {
    if (!this.currentWidget) return { type: 'none' };
    const event = this.currentWidget.handleKey(key);

    if (event.type === 'cancel') {
      // Cancel edit — return to navigate, discard changes
      this.mode = 'navigate';
      this.currentWidget = null;
      return { type: 'mode-change', mode: 'navigate' };
    }

    if (event.type === 'submit' || event.type === 'select' || event.type === 'answer') {
      const step = this.steps[this.currentIndex];
      step.onResult(event, this.accumulated);
      this.completedSteps.add(this.currentIndex);
      // Auto-advance to next visible field
      const next = this.findNextVisible(this.currentIndex, 1);
      if (next !== this.currentIndex) this.currentIndex = next;
      this.mode = 'navigate';
      this.currentWidget = null;
      return { type: 'mode-change', mode: 'navigate' };
    }

    return { type: 'widget-event', event };
  }

  private findNextVisible(from: number, direction: 1 | -1): number {
    let i = from + direction;
    while (i >= 0 && i < this.steps.length) {
      const step = this.steps[i];
      if (!step.condition || step.condition(this.accumulated)) {
        return i;
      }
      i += direction;
    }
    return from; // no valid step found, stay put
  }

  trySubmit(): FlowEvent {
    const missing = this.getMissingRequired();
    if (missing.length > 0) {
      this.currentIndex = missing[0];
      return { type: 'none' };
    }
    this.complete = true;
    return { type: 'flow-complete', results: this.accumulated };
  }

  getMissingRequired(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (step.condition && !step.condition(this.accumulated)) continue;
      if (step.required && !this.completedSteps.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  getCurrentState(): { stepId: string; widget: Widget; progress: number } {
    const step = this.steps[this.currentIndex];
    return {
      stepId: step?.id ?? '',
      widget: this.currentWidget!,
      progress: this.currentIndex / this.steps.length,
    };
  }

  setMode(mode: 'navigate' | 'edit'): void {
    this.mode = mode;
    if (mode === 'navigate') {
      // Position cursor on first visible step
      this.currentIndex = this.findNextVisible(-1, 1);
      this.currentWidget = null;
    }
  }

  getMode(): 'legacy' | 'navigate' | 'edit' {
    return this.mode;
  }

  isComplete(): boolean {
    return this.complete;
  }

  getResults(): Record<string, any> {
    return this.accumulated;
  }

  getFlowSummary(): FlowStepSummary[] {
    if (this.mode === 'legacy') {
      return this.steps.map((step, i) => {
        if (i < this.currentIndex) {
          const value = step.displayValue
            ? step.displayValue(this.accumulated)
            : this.defaultDisplayValue(step.id);
          return { id: step.id, label: step.label, fieldState: 'completed' as const, value };
        }
        if (i === this.currentIndex) {
          return { id: step.id, label: step.label, fieldState: 'active' as const };
        }
        if (step.condition && !step.condition(this.accumulated)) {
          return { id: step.id, label: step.label, fieldState: 'grayed' as const };
        }
        return { id: step.id, label: step.label, fieldState: 'pending' as const };
      });
    }

    // Navigate/edit modes
    return this.steps.map((step, i) => {
      const base = { id: step.id, label: step.label };
      if (step.condition && !step.condition(this.accumulated)) {
        return { ...base, fieldState: 'grayed' as const };
      }
      if (i === this.currentIndex && this.mode === 'edit') {
        if (this.completedSteps.has(i)) {
          const value = step.displayValue ? step.displayValue(this.accumulated) : this.defaultDisplayValue(step.id);
          return { ...base, fieldState: 'editing' as const, value };
        }
        return { ...base, fieldState: 'editing' as const };
      }
      if (this.completedSteps.has(i)) {
        const value = step.displayValue ? step.displayValue(this.accumulated) : this.defaultDisplayValue(step.id);
        return { ...base, fieldState: 'completed' as const, value };
      }
      if (i === this.currentIndex) {
        return { ...base, fieldState: 'active' as const };
      }
      return { ...base, fieldState: 'pending' as const };
    });
  }

  private defaultDisplayValue(stepId: string): string {
    const val = this.accumulated[stepId];
    if (val === undefined || val === null) return '';
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (typeof val === 'string') return val || '(default)';
    if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '(none)';
    return String(val);
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
