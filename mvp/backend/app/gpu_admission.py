"""One cooperating GPU task per workstation, including inference/training."""
from contextlib import contextmanager
from pathlib import Path
import fcntl
import time

class GPUResourceBusy(RuntimeError):
    pass

@contextmanager
def gpu_slot(path: Path, wait: bool = False, stop=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as lock:
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not wait or (stop is not None and stop.is_set()):
                    raise GPUResourceBusy('GPU đang được tác vụ khác sử dụng')
                if stop is not None:stop.wait(.25)
                else:time.sleep(.25)
        try:
            # The child inherits this descriptor: if the parent crashes, another
            # cooperating process still waits for the child to release the GPU.
            yield lock.fileno()
        finally:
            # Closing instead of LOCK_UN: an inherited child descriptor must
            # retain the lock if the parent exits before the child.
            pass
