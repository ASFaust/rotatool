# models.py
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class Person(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False, unique=True)
    start_date = db.Column(db.Date, nullable=False)
    leaving_date = db.Column(db.Date, nullable=False)
    leader = db.Column(db.Boolean, default=False)
    part_time = db.Column(db.Boolean, default=False)
    day_off_every = db.Column(db.Integer, default=10, nullable=False)
    days_off_past = db.Column(db.Integer, default=0)
    days_off_total = db.Column(db.Integer, default=0)
    duty_sheet_trained = db.Column(db.Boolean, default=False)
    ms_leader = db.Column(db.Boolean, default=False)
    driver = db.Column(db.Boolean, default=False)

class Shift(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False, unique=True)
    is_daily = db.Column(db.Boolean, default=False)
    day_of_the_week = db.Column(db.String(10), nullable=True)
    start_time = db.Column(db.Time, nullable=False)
    end_time = db.Column(db.Time, nullable=False)
    monitoring = db.Column(db.Boolean, default=False)
    pa = db.Column(db.Boolean, default=False)
    other_area = db.Column(db.Boolean, default=False)