
export const state = {
  user: { name: "Admin User", initials: "AU", id: "Emp01" },
  authenticated: false,
  timer: {
    intervalId: null,
    startTime: null,
    isRunning: false,
    lastDuration: 0,
    lastAutoStatus: null,
  },
  /** Per-employee P/HL thresholds from status API or shift settings (seconds). */
  attendanceShiftThresholds: null,
  employees: [],
  interns: [],
  selectedIntern: null,
  selectedInternId: null,
  clients: [],
  teamHierarchy: {
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
    grouped: false,
    groups: []
  },
  teamHierarchyFilters: {
    search: '',
    manager: '',
    department: '',
    groupByManager: false,
    viewMode: 'table'
  },
  leaves: [],
  tasks: [],
  timesheet: [],
  assets: [],
  currentAttendanceDate: new Date(),
  attendanceData: {},
  attendanceFilter: "week",
  // Lightweight client-side caches to avoid repeated network calls
  cache: {
    employees: {},   // key: `${page}|${pageSize}` -> { data, fetchedAt }
    leaves: {},      // key: employeeId -> { data, fetchedAt }
    attendance: {},  // key: `${employeeId}|${year}|${month}` -> { data, fetchedAt }
  },
  permissionRequests: [],
  compOffs: [
    // { employeeId: "EMP001", employeeName: "Vigneshraja S", availableDays: 2.5 },
    // { employeeId: "EMP002", employeeName: "Jane Smith", availableDays: 3 },
    // { employeeId: "EMP003", employeeName: "Peter Jones", availableDays: 0 },
    // { employeeId: "EMP004", employeeName: "Mary Johnson", availableDays: 1 },
  ],
  compOffRequests: [
    {
      id: 1,
      employeeId: "EMP001",
      employeeName: "Vigneshraja S",
      dateWorked: "2025-10-18",
      reason: "Worked on Saturday for critical release",
      status: "Approved",
      appliedDate: "2025-10-20",
    },
    {
      id: 2,
      employeeId: "EMP002",
      employeeName: "Jane Smith",
      dateWorked: "2025-10-19",
      reason: "Weekend support for server migration",
      status: "Pending",
      appliedDate: "2025-10-21",
    },
  ],
};