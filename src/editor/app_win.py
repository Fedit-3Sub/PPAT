from typing import *

from pyvistaqt import MainWindow
from qtpy.QtCore import *
from qtpy.QtGui import *
from qtpy.QtWidgets import *

from .conf import Settings
from .controllers.app_controller import AppController
from .views.app_frame import AppFrame


class AppWindow(MainWindow):
    def __init__(self):
        super().__init__()

        #
        self._frame = AppFrame(self)
        self.setWindowTitle(Settings.APP_NAME)
        self.setCentralWidget(self._frame)
        MenuMaker(self).run()
        ToolbarMaker(self).run()

        #
        self._controller = AppController(self._frame)
        self.signal_close.connect(self._controller.close)

        self.statusBar().showMessage(" 편집기가 실행되었습니다.", 3000)

    @property
    def controller(self) -> AppController:
        return self._controller

    def on_new_project(self) -> None:  # 새 프로젝트
        pass

    def on_open_project(self) -> None:  # 불러오기
        pass

    def on_save_project(self) -> None:  # 저장하기
        pass

    def on_particle_properties(self) -> None:  # 입자 속성
        pass

    def on_structure_properties(self) -> None:  # 구조물
        pass

    def on_initial_particle(self) -> None:  # 초기 입자
        pass

    def on_particle_source(self) -> None:  # 생성판
        pass

    def on_particle_sink(self) -> None:  # 소멸판
        pass

    def on_region(self) -> None:  # 구역
        pass

    def on_user_function(self) -> None:  # 사용자 정의 함수
        pass

    def on_analysis_settings(self) -> None:  # 해석 설정
        pass

    def on_run_analysis(self) -> None:  # 해석 실행
        pass

    def on_stop_analysis(self) -> None:  # 해석 종료
        pass

    def on_view_analysis(self) -> None:  # 해석 실행
        filename, _ = QFileDialog.getOpenFileName(self, '파일 열기', './', '*.dat')
        self._controller.generate_streamlines()  # FIXME: 임시로 여기에 갖다 놓음.

    def on_import_stl(self) -> None:  # STL Import
        filename, _ = QFileDialog.getOpenFileName(self, '파일 열기', './', '*.stl')
        self._controller.import_stl(filename)

    def on_import_cad(self) -> None:  # CAD Import
        pass

    def on_export_stl(self) -> None:  # STL Export
        filename, _ = QFileDialog.getSaveFileName(self, '파일 저장', './', '*.stl')
        # self._controller.import_stl(filename)

    def on_report_gaps(self) -> None:  # Report Gaps
        pass

    def on_fix_gaps(self) -> None:  # Fix Gaps
        pass

    def on_add_sphere(self) -> None:  # Sphere
        pass

    def on_add_cuboid(self) -> None:  # Cuboid
        pass

    def on_add_cone(self) -> None:  # Cone
        pass

    def on_add_cylinder(self) -> None:  # Cylinder
        pass

    def on_add_torus(self) -> None:  # Torus
        pass

    def on_add_cylindrical_sheet(self) -> None:  # CylindricalSheet
        pass

    def on_add_toroidal_sheet(self) -> None:  # ToroidalSheet
        pass

    def on_add_circular_sheet(self) -> None:  # CircularSheet
        pass

    def on_add_rectangular_sheet(self) -> None:  # RectangularSheet
        pass

    def on_new_sketch(self) -> None:  # New Sketch
        pass

    def on_work_plane(self) -> None:  # Work Plane
        pass

    def on_rectangle(self) -> None:  # Rectangle
        pass

    def on_circle(self) -> None:  # Circle
        pass

    def on_polygon(self) -> None:  # Polygon
        pass

    def on_ellipse(self) -> None:  # Ellipse
        pass

    def on_tan2circles(self) -> None:  # Tan2Circles
        pass

    def on_line(self) -> None:  # Line
        pass

    def on_arc(self) -> None:  # Arc
        pass

    def on_polyline(self) -> None:  # Polyline
        pass

    def on_spline(self) -> None:  # Spline
        pass

    def on_center_line(self) -> None:  # Center Line
        pass

    def on_point(self) -> None:  # Point
        pass

    def on_extrude(self) -> None:  # Extrude
        pass

    def on_revolve(self) -> None:  # Revolve
        pass

    def on_tessellation_control(self) -> None:  # Tessellation Control
        pass

    def on_dynamic_facet(self) -> None:  # Dynamic Facet
        pass

    def on_body_copy(self) -> None:  # Body Copy
        pass

    def on_body_delete(self) -> None:  # Body Delete
        pass

    def on_body_move(self) -> None:  # Body Move
        pass

    def on_body_rotate(self) -> None:  # Body Rotate
        pass

    def on_body_scale(self) -> None:  # Body Scale
        pass

    def on_fillet(self) -> None:  # Fillet / Round
        pass

    def on_chmfer(self) -> None:  # Chmfer
        pass

    def on_defeature(self) -> None:  # Defeature
        pass

    def on_color_and_transparent(self) -> None:  # Color and Transparent
        pass

    def on_union(self) -> None:  # Union
        pass

    def on_subtract(self) -> None:  # Subtract
        pass

    def on_intersection(self) -> None:  # Intersection
        pass

    def on_separate_structure(self) -> None:  # 구조물 분리
        pass

    def on_connect_structures(self) -> None:  # 구조물 결합
        pass

    def on_rotate_ccw(self) -> None:  # 객체 회전 CCW
        pass

    def on_rotate_cw(self) -> None:  # 객체 회전 CW
        pass

    def on_translate_north(self) -> None:  # 방향 이동: N
        pass

    def on_translate_south(self) -> None:  # 방향 이동: S
        pass

    def on_translate_east(self) -> None:  # 방향 이동: E
        pass

    def on_translate_west(self) -> None:  # 방향 이동: W
        pass

    def on_scale_plus(self) -> None:  # 크기 조절 (+)
        pass

    def on_scale_minus(self) -> None:  # 크기 조절 (-)
        pass

    def on_scale_reset(self) -> None:  # 크기 조절 (1)
        pass

    def on_undo(self) -> None:
        pass

    def on_redo(self) -> None:
        self.statusBar().showMessage("REDO !!")
        pass


class MenuMaker:
    def __init__(self, win: 'AppWindow'):
        self._win = win

    def run(self) -> None:
        self.create_project_menu()
        self.create_analysis_menu()
        self.create_geometry_menu()
        self.create_edit_menu()

    def set_menu_handler(self, menu: QMenu, title: str, handler: Callable[[], None]) -> None:
        action = QAction(title, self._win)
        action.triggered.connect(handler)
        menu.addAction(action)

    def set_menu_header(self, menu: QMenu, title: str) -> None:
        action = QAction(title, self._win)
        action.setDisabled(True)
        menu.addAction(action)

    def create_project_menu(self) -> None:
        menu = self._win.menuBar().addMenu('프로젝트')
        self.set_menu_handler(menu, '새 프로젝트', self._win.on_new_project)
        self.set_menu_handler(menu, '불러오기', self._win.on_open_project)
        self.set_menu_handler(menu, '저장하기', self._win.on_save_project)

    def create_analysis_menu(self) -> None:
        menu = self._win.menuBar().addMenu('해석')

        # 입자 속성
        self.set_menu_header(menu, '입자 속성')
        self.set_menu_handler(menu, '입자 속성', self._win.on_particle_properties)
        menu.addSeparator()

        # 구조 속성
        self.set_menu_header(menu, '구조 속성')
        self.set_menu_handler(menu, '구조물', self._win.on_structure_properties)
        menu.addSeparator()

        # 경계 조건
        self.set_menu_header(menu, '경계 조건')
        self.set_menu_handler(menu, '초기 입자', self._win.on_initial_particle)
        self.set_menu_handler(menu, '생성판', self._win.on_particle_source)
        self.set_menu_handler(menu, '소멸판', self._win.on_particle_sink)
        self.set_menu_handler(menu, '구역', self._win.on_region)
        menu.addSeparator()

        # 사용자 정의 함수
        self.set_menu_header(menu, '사용자 정의 함수')
        self.set_menu_handler(menu, '사용자 정의 함수', self._win.on_user_function)
        menu.addSeparator()

        # 해석 설정
        self.set_menu_header(menu, '해석 설정')
        self.set_menu_handler(menu, '해석 설정', self._win.on_analysis_settings)
        menu.addSeparator()

        # 해석
        self.set_menu_header(menu, '해석')
        self.set_menu_handler(menu, '해설 실행', self._win.on_run_analysis)
        self.set_menu_handler(menu, '해석 종료', self._win.on_stop_analysis)
        self.set_menu_handler(menu, '해석 데이터 현시', self._win.on_view_analysis)

    def create_geometry_menu(self) -> None:
        menu = self._win.menuBar().addMenu('기하')

        # Import
        self.set_menu_header(menu, 'Import')
        self.set_menu_handler(menu, 'STL Import', self._win.on_import_stl)
        self.set_menu_handler(menu, 'CAD Import', self._win.on_import_cad)
        menu.addSeparator()

        # Export
        self.set_menu_header(menu, 'Export')
        self.set_menu_handler(menu, 'STL Export', self._win.on_export_stl)
        menu.addSeparator()

        # Repair
        self.set_menu_header(menu, 'Repair')
        self.set_menu_handler(menu, 'Report Gaps', self._win.on_report_gaps)
        self.set_menu_handler(menu, 'Fix Gaps', self._win.on_fix_gaps)
        menu.addSeparator()

        # Primitive Object
        self.set_menu_header(menu, 'Primitive Object')
        self.set_menu_handler(menu, 'Sphere', self._win.on_add_sphere)
        self.set_menu_handler(menu, 'Cuboid', self._win.on_add_cuboid)
        self.set_menu_handler(menu, 'Cone', self._win.on_add_cone)
        self.set_menu_handler(menu, 'Cylinder', self._win.on_add_cylinder)
        self.set_menu_handler(menu, 'Torus', self._win.on_add_torus)
        self.set_menu_handler(menu, 'CylindricalSheet', self._win.on_add_cylindrical_sheet)
        self.set_menu_handler(menu, 'ToroidalSheet', self._win.on_add_toroidal_sheet)
        self.set_menu_handler(menu, 'CircularSheet', self._win.on_add_circular_sheet)
        self.set_menu_handler(menu, 'RectangularSheet', self._win.on_add_rectangular_sheet)
        menu.addSeparator()

        # Sketch
        self.set_menu_header(menu, 'Sketch')
        self.set_menu_handler(menu, 'New Sketch', self._win.on_new_sketch)
        self.set_menu_handler(menu, 'Work Plane', self._win.on_work_plane)
        self.set_menu_handler(menu, 'Rectangle', self._win.on_rectangle)
        self.set_menu_handler(menu, 'Circle', self._win.on_circle)
        self.set_menu_handler(menu, 'Polygon', self._win.on_polygon)
        self.set_menu_handler(menu, 'Ellipse', self._win.on_ellipse)
        self.set_menu_handler(menu, 'Tan2Circles', self._win.on_tan2circles)
        self.set_menu_handler(menu, 'Line', self._win.on_line)
        self.set_menu_handler(menu, 'Arc', self._win.on_arc)
        self.set_menu_handler(menu, 'Polyline', self._win.on_polyline)
        self.set_menu_handler(menu, 'Spline', self._win.on_spline)
        self.set_menu_handler(menu, 'Center Line', self._win.on_center_line)
        self.set_menu_handler(menu, 'Point', self._win.on_point)
        menu.addSeparator()

        # Feature
        self.set_menu_header(menu, 'Feature')
        self.set_menu_handler(menu, 'Extrude', self._win.on_extrude)
        self.set_menu_handler(menu, 'Revolve', self._win.on_revolve)

    def create_edit_menu(self) -> None:
        menu = self._win.menuBar().addMenu('편집')

        # STL Tessellation
        self.set_menu_header(menu, "STL Tessellation")
        self.set_menu_handler(menu, 'Tessellation Control', self._win.on_tessellation_control)
        self.set_menu_handler(menu, 'Dynamic Facet', self._win.on_dynamic_facet)
        menu.addSeparator()

        # Edit
        self.set_menu_header(menu, 'Edit')
        self.set_menu_handler(menu, 'Body Copy', self._win.on_body_copy)
        self.set_menu_handler(menu, 'Body Delete', self._win.on_body_delete)
        menu.addSeparator()

        # Transform
        self.set_menu_header(menu, 'Transform')
        self.set_menu_handler(menu, 'Body Move', self._win.on_body_move)
        self.set_menu_handler(menu, 'Body Rotate', self._win.on_body_rotate)
        self.set_menu_handler(menu, 'Body Scale', self._win.on_body_scale)
        menu.addSeparator()

        # Blending
        self.set_menu_header(menu, 'Blending')
        self.set_menu_handler(menu, 'Fillet / Round', self._win.on_fillet)
        self.set_menu_handler(menu, 'Chmfer', self._win.on_chmfer)
        self.set_menu_handler(menu, 'Defeature', self._win.on_defeature)
        menu.addSeparator()

        # Attribute
        self.set_menu_header(menu, 'Attribute')
        self.set_menu_handler(menu, 'Color and Transparent', self._win.on_color_and_transparent)
        menu.addSeparator()

        # Boolean
        self.set_menu_header(menu, 'Boolean')
        self.set_menu_handler(menu, 'Union', self._win.on_union)
        self.set_menu_handler(menu, 'Subtract', self._win.on_subtract)
        self.set_menu_handler(menu, 'Intersection', self._win.on_intersection)


class ToolbarMaker:
    def __init__(self, win: 'AppWindow'):
        self._win = win

    def run(self):
        toolbar = self._win.addToolBar("Edit")
        toolbar.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextUnderIcon)

        self.set_toolbar_handler(toolbar, '구조물 분리', 'separate.png', self._win.on_separate_structure)
        self.set_toolbar_handler(toolbar, '구조물 결합', 'merge.png', self._win.on_connect_structures)
        self.add_separator(toolbar)

        self.set_toolbar_handler(toolbar, '객체 회전 (CCW)', 'rotate-ccw.png', self._win.on_rotate_ccw)
        self.set_toolbar_handler(toolbar, '객체 회전 (CW)', 'rotate-cw.png', self._win.on_rotate_cw)
        self.add_separator(toolbar)

        self.set_toolbar_handler(toolbar, '방향 이동 (T)', 'move-top.png', self._win.on_translate_north)
        self.set_toolbar_handler(toolbar, '방향 이동 (D)', 'move-down.png', self._win.on_translate_south)
        self.set_toolbar_handler(toolbar, '방향 이동 (L)', 'move-left.png', self._win.on_translate_west)
        self.set_toolbar_handler(toolbar, '방향 이동 (R)', 'move-right.png', self._win.on_translate_east)
        self.add_separator(toolbar)

        self.set_toolbar_handler(toolbar, '크기 조절 (+)', 'scale-plus.png', self._win.on_scale_plus)
        self.set_toolbar_handler(toolbar, '크기 조절 (-)', 'scale-minus.png', self._win.on_scale_minus)
        self.set_toolbar_handler(toolbar, '크기 조절 (R)', 'scale-reset.png', self._win.on_scale_reset)
        self.add_separator(toolbar)

        self.set_toolbar_handler(toolbar, '되돌리기', 'undo.png', self._win.on_undo)
        self.set_toolbar_handler(toolbar, '다시 실행', 'redo.png', self._win.on_redo)

    def set_toolbar_handler(self, toolbar: QToolBar, title: str, icon_name: str, handler: Callable[[], None]) -> None:
        icon = QIcon(str(Settings.RES_PATH / icon_name))

        act = QAction(self._win)
        act.setText(title)
        act.setIcon(icon)
        act.triggered.connect(handler)
        act.setEnabled(True)
        toolbar.addAction(act)

        # btn = QToolButton()
        # btn.setToolButtonStyle(Qt.ToolButtonTextUnderIcon)
        # btn.setText(title)
        # btn.setIcon(icon)
        # btn.addAction(act)
        # btn.setCheckable(False)
        # toolbar.addWidget(btn)

    def add_separator(self, toolbar: QToolBar) -> None:
        action = QAction(self._win)
        action.setSeparator(True)
        toolbar.addAction(action)


__all__ = [
    'AppWindow'
]
