import abc
from typing import *

from pyvista.plotting.actor import Actor
from qtpy.QtWidgets import *


class SceneNavigatorDelegate:
    __metaclass__ = abc.ABCMeta

    @abc.abstractmethod
    def on_actor_selected(self, index: int, actor: Actor) -> None:
        pass


class SceneNavigator(QWidget):
    def __init__(self, parent: QWidget | None):
        super().__init__(parent)

        self._delegate: SceneNavigatorDelegate | None = None
        self._closing = False

        self.setMinimumWidth(200)

        rows = QVBoxLayout()
        self.setLayout(rows)

        self._tree = QTreeWidget(self)
        self._tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._tree.itemSelectionChanged.connect(self.on_item_selection_changed)
        self._tree.setColumnCount(2)
        self._tree.setHeaderLabels(['ID', '명칭'])

        rows.addWidget(self._tree)

    @property
    def delegate(self) -> SceneNavigatorDelegate:
        return self._delegate

    @delegate.setter
    def delegate(self, value: SceneNavigatorDelegate):
        self._delegate = value

    def clear(self):
        self._closing = True
        self._tree.clear()
        self._closing = False

    def load_actors(self, actors: Sequence[Actor]) -> None:
        self._tree.clear()

        for idx, actor in enumerate(actors):  # type: int, Actor
            item = QTreeWidgetItem(self._tree)

            item.setText(0, f"{idx + 1}")

            name = actor.GetObjectName()
            item.setText(1, name or "")

            # custom data
            item._index = idx
            item._actor = actor

    def on_item_selection_changed(self):
        if self._closing:
            return
        
        items: List[QTreeWidgetItem] = self._tree.selectedItems()
        if not items:
            return

        if self._delegate:
            item = items[0]
            idx: int = item._index
            actor: Actor = item._actor
            self._delegate.on_actor_selected(idx, actor)


__all__ = [
    'SceneNavigator',
    'SceneNavigatorDelegate',
]
