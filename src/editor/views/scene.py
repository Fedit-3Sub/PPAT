from pyvistaqt import QtInteractor
from qtpy.QtWidgets import *


class SceneView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._plotter = QtInteractor(self)
        self._plotter.set_background('#80D0C7', top='#0093E9')
        # self._plotter.enable_shadows()

        rows = QVBoxLayout()
        self.setLayout(rows)
        rows.addWidget(self._plotter.interactor)

    @property
    def plotter(self) -> QtInteractor:
        return self._plotter


__all__ = [
    'SceneView'
]
