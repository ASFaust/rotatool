from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class Person(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False, unique=True)
    start_date = db.Column(db.Date, nullable=False)
    leaving_date = db.Column(db.Date, nullable=False)
    leader = db.Column(db.Boolean, default=False)
    part_time = db.Column(db.Boolean, default=False)
    activated = db.Column(db.Boolean, default=True)  # New field

class Shift(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False, unique=True)
    day_of_the_week = db.Column(db.String(10), nullable=False)
    start_time = db.Column(db.Time, nullable=False)
    end_time = db.Column(db.Time, nullable=False)
    type = db.Column(db.String(20), nullable=False)
    number_of_people = db.Column(db.Integer, nullable=False, default=1)
    optional = db.Column(db.Boolean, default=False)
    activated = db.Column(db.Boolean, default=True)  # New field

class Skill(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False, unique=True)

class PersonSkill(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    person_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    skill_id = db.Column(db.Integer, db.ForeignKey('skill.id'), nullable=False)
    person = db.relationship('Person', backref=db.backref('person_skills', cascade='all, delete-orphan'))
    skill = db.relationship('Skill', backref=db.backref('person_skills', cascade='all, delete-orphan'))

class ShiftSkill(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    shift_id = db.Column(db.Integer, db.ForeignKey('shift.id'), nullable=False)
    skill_id = db.Column(db.Integer, db.ForeignKey('skill.id'), nullable=False)
    shift = db.relationship('Shift', backref=db.backref('shift_skills', cascade='all, delete-orphan'))
    skill = db.relationship('Skill', backref=db.backref('shift_skills', cascade='all, delete-orphan'))

class ManualShift(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    person_id = db.Column(db.Integer, db.ForeignKey('person.id'), nullable=False)
    day = db.Column(db.String(10), nullable=False)
    shift_id = db.Column(db.Integer, db.ForeignKey('shift.id'), nullable=True)
    non_shift_info = db.Column(db.String(50), nullable=True)

    person = db.relationship('Person', backref=db.backref('manual_shifts', cascade='all, delete-orphan'))
    shift = db.relationship('Shift', backref=db.backref('manual_shifts', cascade='all, delete-orphan'))

    @property
    def is_valid(self):
        return self.shift_id is not None or self.non_shift_info is not None