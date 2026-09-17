# Temporary Linux CI diagnostic. Read frame metadata only, never locals or payloads.
python
import gdb

def collect_control_stack_frames():
    thread = gdb.selected_thread()
    if thread is None:
        print("CONTROL_STACK_FRAMES unavailable: inferior has no stopped thread")
        return
    print("CONTROL_STACK_FRAMES begin thread=%s" % (thread.ptid,))
    frame = gdb.newest_frame()
    rows = []
    for index in range(160):
        if frame is None:
            break
        try:
            sp = int(frame.read_register("rsp"))
            pc = int(frame.pc())
            name = frame.name() or "<unknown>"
            kind = frame.type()
            sal = frame.find_sal()
            location = "%s:%s" % (sal.symtab.filename, sal.line) if sal.symtab else "<unknown>"
            rows.append((index, sp, pc, name, kind, location))
            frame = frame.older()
        except gdb.error as error:
            print("CONTROL_STACK_FRAMES unwind_error index=%d error=%s" % (index, error))
            break

    # Linux mappings establish whether the faulting SP is at the stack guard.
    # Print only the mapping containing SP and its immediate predecessor.
    if rows:
        try:
            with open("/proc/%d/maps" % gdb.selected_inferior().pid) as mappings:
                previous = ""
                for mapping in mappings:
                    bounds = mapping.split()[0].split("-")
                    low, high = (int(bound, 16) for bound in bounds)
                    if low <= rows[0][1] < high:
                        print("CONTROL_STACK_MAPPING previous=" + previous.strip())
                        print("CONTROL_STACK_MAPPING current=" + mapping.strip())
                        print("CONTROL_STACK_MAPPING sp_offset=%d mapping_bytes=%d" % (rows[0][1] - low, high - low))
                        break
                    previous = mapping
        except OSError as error:
            print("CONTROL_STACK_MAPPING unavailable: %s" % error)

    ranked = []
    for position, row in enumerate(rows):
        index, sp, pc, name, kind, location = row
        delta = rows[position + 1][1] - sp if position + 1 < len(rows) else None
        print("CONTROL_STACK_FRAME index=%d sp=0x%x pc=0x%x caller_sp_delta=%s kind=%d location=%s function=%s" % (index, sp, pc, delta, kind, location, name))
        if delta is not None and delta > 0:
            ranked.append((delta, index, name))
    for delta, index, name in sorted(ranked, reverse=True)[:20]:
        print("CONTROL_STACK_LARGEST index=%d caller_sp_delta=%d function=%s" % (index, delta, name))
    if rows:
        print("CONTROL_STACK_FRAMES end count=%d observed_span=%d truncated=%s" % (len(rows), rows[-1][1] - rows[0][1], frame is not None))
    print("CONTROL_STACK_FRAMES note: deltas are unwound SP differences, not exact local sizes; inline frames may share SP")

try:
    collect_control_stack_frames()
except Exception as error:
    # Keep the regular backtraces even if this optional diagnostic fails.
    print("CONTROL_STACK_FRAMES failed: %s" % error)
end
