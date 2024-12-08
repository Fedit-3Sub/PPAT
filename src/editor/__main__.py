import sys

from qtpy.QtGui import *
from qtpy.QtWidgets import *

from .app_win import AppWindow
from .conf import Settings

if __name__ == '__main__':

    app = QApplication(sys.argv)
    app.setApplicationDisplayName(Settings.APP_NAME)
    app.setQuitOnLastWindowClosed(True)
    app.setWindowIcon(QIcon(str(Settings.RES_PATH / 'app-icon.png')))

    app.setStyle("""QToolButton:pressed {
        background-color: red;
    }""")

    win = AppWindow()
    win.showMaximized()

    try:
        sys.exit(app.exec_())
    except KeyboardInterrupt:
        sys.exit(0)
