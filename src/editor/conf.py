import pathlib


class Settings:
    RES_PATH = pathlib.Path(__file__).parent / 'res'
    APP_NAME = '디지털 트윈 - 시뮬레이션 전처리 저작도구'


__all__ = [
    'Settings'
]
