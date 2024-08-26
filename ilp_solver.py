import pulp
from models import Shift, Person, Skill, ShiftSkill, PersonSkill
from datetime import datetime, time, timedelta

"""
The ILP problem we want to solve:

we want to assign people to shifts in such a way that:
- Each shift has the required number of people
- Each person has nearly the same number of shifts as others on the same day
- For each skill, at least one person on each shift has that skill
- same number of morning surveys for every person per week
- no slideshow on days before morning surveys
- no shifts with overlapping time windows
- diversify shifts for each person: minimize the number of shifts that are the same for each person

Therefore, the optimization problem is to maximize the total number of assigned shifts while satisfying the constraints above.

we always generate a rota for monday till sunday, 7 days in total.

The decision variables are:
- x[i][j] = 1 if person i is assigned to shift j, 0 otherwise

The objective function is:
- Maximize the total number of assigned shifts

database schema:

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

class Shift(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False, unique=True)
    day_of_the_week = db.Column(db.String(10), nullable=False) "Every Day","Monday", etc.
    start_time = db.Column(db.Time, nullable=False)
    end_time = db.Column(db.Time, nullable=False)
    type = db.Column(db.String(20), nullable=False) "Morning Survey", "Night Survey", "Slideshow", etc.
    number_of_people = db.Column(db.Integer, nullable=False, default=1)  # New field

class Skill(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False, unique=True)

# models.py
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

since we have shifts that are "daily", we need to first expand those into 7 shifts, one for each day of the week. 

"""

def are_shifts_in_proximity(shift1, shift2, proximity_minutes=20):
    proximity_seconds = proximity_minutes * 60

    # Check if shifts overlap
    latest_start = max(shift1['start_time'], shift2['start_time'])
    earliest_end = min(shift1['end_time'], shift2['end_time'])

    # Overlap case: If the latest start is before or equal to the earliest end, shifts overlap
    if latest_start <= earliest_end:
        return True

    # Otherwise, calculate the gap between the shifts
    start_end_gap = (latest_start - earliest_end).total_seconds()

    # If the gap is less than or equal to the proximity, return True
    return start_end_gap <= proximity_seconds

def expand_shifts(shifts, start_of_next_week):
    all_shifts = []
    morning_survey_shifts = []
    shift_id = 0

    for shift in shifts:
        if shift.day_of_the_week == "Every Day":
            for i, day in enumerate(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]):
                shift_start = datetime.combine(start_of_next_week, shift.start_time) + timedelta(days=i)
                shift_end = datetime.combine(start_of_next_week, shift.end_time) + timedelta(days=i)
                shift_data = {
                    'name': shift.name,
                    'shift': shift,
                    'start_time': shift_start,
                    'end_time': shift_end,
                    'id': shift_id
                }
                all_shifts.append(shift_data)
                if shift.type == "Morning Survey":
                    morning_survey_shifts.append(shift_data)
                shift_id += 1
        else:
            shift_start = datetime.combine(start_of_next_week, shift.start_time)
            shift_end = datetime.combine(start_of_next_week, shift.end_time)
            shift_data = {
                'name': shift.name,
                'shift': shift,
                'start_time': shift_start,
                'end_time': shift_end,
                'id': shift_id
            }
            all_shifts.append(shift_data)
            if shift.type == "Morning Survey":
                morning_survey_shifts.append(shift_data)
            shift_id += 1

    return all_shifts, morning_survey_shifts

def define_decision_variables(persons, all_shifts):
    x = pulp.LpVariable.dicts("shifts", ((person.id, shift['id']) for person in persons for shift in all_shifts), cat='Binary')
    max_shifts = pulp.LpVariable("max_shifts", lowBound=0, cat="Integer")
    morning_survey_max_shifts = pulp.LpVariable("morning_survey_max_shifts", lowBound=0, cat="Integer")
    morning_survey_min_shifts = pulp.LpVariable("morning_survey_min_shifts", lowBound=0, cat="Integer")
    return x, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts

def add_constraints(prob, persons, all_shifts, x, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts):
    # Disallow assigning shifts that start/end within 20 minutes of each other
    for person in persons:
        for i, shift1 in enumerate(all_shifts):
            for j, shift2 in enumerate(all_shifts):
                if i < j and are_shifts_in_proximity(shift1, shift2):
                    prob += x[person.id, shift1['id']] + x[person.id, shift2['id']] <= 1

    # Enforce number of people constraints on each shift
    for shift in all_shifts:
        prob += pulp.lpSum(x[person.id, shift['id']] for person in persons) == shift['shift'].number_of_people

    # Ensure max_shifts is greater than or equal to the number of shifts assigned to any person
    for person in persons:
        prob += max_shifts >= pulp.lpSum(x[person.id, shift['id']] for shift in all_shifts)

    # Ensure fair distribution of morning surveys
    for person in persons:
        morning_survey_count = pulp.lpSum(x[person.id, shift['id']] for shift in all_shifts if shift['shift'].type == "Morning Survey")
        prob += morning_survey_max_shifts >= morning_survey_count
        prob += morning_survey_min_shifts <= morning_survey_count

def set_objective(prob, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts):
    prob.setObjective(max_shifts + (morning_survey_max_shifts - morning_survey_min_shifts))
def solve_ilp():
    # Define the problem
    prob = pulp.LpProblem("ShiftScheduling", pulp.LpMinimize)

    # Get data
    persons = Person.query.all()
    shifts = Shift.query.all()

    # Calculate start of next week
    now = datetime.now()
    days_until_next_monday = (7 - now.weekday()) % 7
    if days_until_next_monday == 0:
        days_until_next_monday = 7
    start_of_next_week = (now + timedelta(days=days_until_next_monday)).replace(hour=0, minute=0, second=0, microsecond=0)

    # Expand shifts
    all_shifts, morning_survey_shifts = expand_shifts(shifts, start_of_next_week)

    # Define decision variables
    x, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts = define_decision_variables(persons, all_shifts)

    # Add constraints
    add_constraints(prob, persons, all_shifts, x, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts)

    # Set objective
    set_objective(prob, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts)

    # Solve the problem
    prob.solve()

    print("Status:", pulp.LpStatus[prob.status])

    # Print result
    for person in persons:
        for shift in all_shifts:
            if pulp.value(x[person.id, shift['id']]) == 1:
                print(f"Person {person.name} is assigned to shift {shift['name']} on {shift['start_time'].strftime('%A')}")