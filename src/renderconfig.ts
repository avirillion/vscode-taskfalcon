
export type PreviewConfig = {
    showIDs: boolean;
    showClosedTasks: boolean;
    hideTasks: boolean;
    showEnds: boolean;
    showEfforts: boolean;
    showEffortsSpent: boolean;
    showEffortsLeft: boolean;
    showDone: boolean;
    chart: 'gantt' | 'gantt-with-resources' | 'resources' | 'resources-with-tasks';
    prefix: string;
    today: string;
    noUpdates: boolean;
    allUpdates: boolean;
    scale: '' | 'day' | 'week' | 'month' | 'year';
    start: string;
    end: string;
    tags: string;
    freeParams: string;
};

export const defaultConfig: PreviewConfig = {
    showIDs: false,
    showClosedTasks: false,
    hideTasks: false,
    showEfforts: false,
    showEffortsSpent: false,
    showEffortsLeft: false,
    showEnds: false,
    showDone: false,
    chart: 'gantt',
    prefix: '',
    today: '',
    scale: '',
    start: '',
    end: '',
    noUpdates: false,
    allUpdates: false,
    tags: '',
    freeParams: '',
};
