/**
 * Minimal logging interface + levels shared by every script. OtlpLogger (in
 * shared/otlpTelemetry.ts) implements ILogger, so anything written against this
 * interface can ship its logs to an OpenTelemetry collector without changes.
 */
export var LogLevel;
(function (LogLevel) {
    LogLevel[LogLevel["ERROR"] = 0] = "ERROR";
    LogLevel[LogLevel["WARNING"] = 1] = "WARNING";
    LogLevel[LogLevel["INFO"] = 2] = "INFO";
    LogLevel[LogLevel["VERBOSE"] = 3] = "VERBOSE";
    LogLevel[LogLevel["DEBUG"] = 4] = "DEBUG";
    LogLevel[LogLevel["GLOBAL"] = 100] = "GLOBAL";
})(LogLevel || (LogLevel = {}));
/** Swallows everything. Useful as a default when a caller passes no logger. */
export class NullLogger {
    log(message, level = LogLevel.INFO) {
        return true;
    }
}
/**
 * Plain in-game logger: writes to the script's own log (tail), and to the
 * terminal for WARNING/ERROR (or everything, with logToTerminal = true).
 */
export class Logger {
    ns;
    level;
    logToTerminal;
    constructor(ns, level = LogLevel.ERROR, logToTerminal = false) {
        this.ns = ns;
        this.level = level;
        this.logToTerminal = logToTerminal;
    }
    set logLevel(level) {
        this.level = level;
    }
    log(message, level = LogLevel.INFO) {
        if (level === LogLevel.GLOBAL || level <= this.level) {
            const m = level === LogLevel.GLOBAL ? message : `[${this.levelName(level)}] ${message}`;
            this.ns.print(m);
            if (this.logToTerminal || level <= LogLevel.WARNING) {
                this.ns.tprint(m);
            }
            return true;
        }
        else {
            return false;
        }
    }
    levelName(level) {
        switch (level) {
            case LogLevel.ERROR:
                return "ERROR";
            case LogLevel.WARNING:
                return "WARNING";
            case LogLevel.INFO:
                return "INFO";
            case LogLevel.VERBOSE:
                return "VERBOSE";
            case LogLevel.DEBUG:
                return "DEBUG";
            case LogLevel.GLOBAL:
                return "GLOBAL";
            default:
                return "UNKNOWN";
        }
    }
}
