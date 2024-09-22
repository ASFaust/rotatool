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
    any_day_groups = []
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
                    'id': shift_id,
                    'skills': [ss.skill for ss in shift.shift_skills],
                    'any_day': False
                }
                all_shifts.append(shift_data)
                shift_id += 1
        elif shift.day_of_the_week == "Any Day":
            new_group = []
            for i, day in enumerate(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]):
                shift_start = datetime.combine(start_of_next_week, shift.start_time) + timedelta(days=i)
                shift_end = datetime.combine(start_of_next_week, shift.end_time) + timedelta(days=i)
                shift_data = {
                    'name': shift.name,
                    'shift': shift,
                    'start_time': shift_start,
                    'end_time': shift_end,
                    'id': shift_id,
                    'skills': [ss.skill for ss in shift.shift_skills],
                    'any_day': True
                }
                new_group.append(shift_data)
                all_shifts.append(shift_data)
                shift_id += 1
            any_day_groups.append(new_group)
        else:
            shift_start = datetime.combine(start_of_next_week, shift.start_time)
            #add the day of the week now:
            shift_start = shift_start + timedelta(days=["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].index(shift.day_of_the_week))
            shift_end = datetime.combine(start_of_next_week, shift.end_time)
            shift_data = {
                'name': shift.name,
                'shift': shift,
                'start_time': shift_start,
                'end_time': shift_end,
                'id': shift_id,
                'skills': [ss.skill for ss in shift.shift_skills],
                'any_day': False
            }
            all_shifts.append(shift_data)
            shift_id += 1

    return all_shifts, any_day_groups

def define_decision_variables(persons, all_shifts, any_day_groups):
    x = pulp.LpVariable.dicts("shifts", ((person.id, shift['id']) for person in persons for shift in all_shifts), cat='Binary')
    max_shifts = pulp.LpVariable("max_shifts", lowBound=0, cat="Integer")
    morning_survey_max_shifts = pulp.LpVariable("morning_survey_max_shifts", lowBound=0, cat="Integer")
    morning_survey_min_shifts = pulp.LpVariable("morning_survey_min_shifts", lowBound=0, cat="Integer")
    day_selection_vars = []
    for group in any_day_groups:
        #we need to add 7 binary variables, one for each day of the week, per group/shift
        group_vars = []
        for day in group:
            group_vars.append(pulp.LpVariable(f"day_{day['id']}", cat="Binary"))
        day_selection_vars.append(group_vars)
    return x, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts, day_selection_vars

def add_constraints(prob, persons, all_shifts, x, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts, day_selection_vars, any_day_groups):
    # Disallow assigning shifts that start/end within 20 minutes of each other
    for person in persons:
        for i, shift1 in enumerate(all_shifts):
            for j, shift2 in enumerate(all_shifts):
                if i < j and are_shifts_in_proximity(shift1, shift2):
                    prob += x[person.id, shift1['id']] + x[person.id, shift2['id']] <= 1

    # Enforce number of people constraints on each shift (except for shifts that can be assigned to any day - they need to be handled separately)
    for shift in all_shifts:
        if shift['any_day']:
            continue
        prob += pulp.lpSum(x[person.id, shift['id']] for person in persons) >= shift['shift'].number_of_people

    for vars,group in zip(day_selection_vars, any_day_groups):
        prob += pulp.lpSum(vars) == 1

        shift_ids = [shift['id'] for shift in group]
        all_persons_and_shifts = []
        for person in persons:
            for shift_id in shift_ids:
                all_persons_and_shifts.append(x[person.id, shift_id])
        prob += pulp.lpSum(all_persons_and_shifts) >= group[0]['shift'].number_of_people

        for person in persons:
            for i, shift_id in enumerate(shift_ids): #because shift_ids is ordered, we can do that
                prob += x[person.id, shift_id] <= vars[i]


    # Ensure max_shifts is greater than or equal to the number of shifts assigned to any person
    for person in persons:
        prob += max_shifts >= pulp.lpSum(x[person.id, shift['id']] for shift in all_shifts)

    # Ensure fair distribution of morning surveys
    for person in persons:
        morning_survey_count = pulp.lpSum(x[person.id, shift['id']] for shift in all_shifts if shift['shift'].type == "Morning Survey")
        prob += morning_survey_max_shifts >= morning_survey_count
        prob += morning_survey_min_shifts <= morning_survey_count

    # Enforce skill constraints: for each shift, every skill needs to be covered by at least one person
    for shift in all_shifts:
        for skill in shift['skills']:
            #that means we first need to obtain the group of people that have that skill
            skilled_people = [person for person in persons if skill in [ps.skill for ps in person.person_skills]]
            #then we need to check if at least one of them is assigned to the shift
            prob += pulp.lpSum(x[person.id, shift['id']] for person in skilled_people) >= 1



    # Minimize number of consecutive Morning Surveys for one person
    ###for person in persons:
    #    for shift1 in all_shifts:
    ##        if shift1['shift'].type == "Morning Survey":
    #            for shift2 in all_shifts:
    #                if shift1['id'] == shift2['id']:
    #                    continue
    #                total_days = (shift2['start_time'] - shift1['start_time']).total_seconds() / 86400
    #                if 0.8 < total_days < 1.2:
    #                    prob += x[person.id, shift1['id']] + x[person.id, shift2['id']] <= 1

def set_objective(prob, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts):
    prob.setObjective(max_shifts + (morning_survey_max_shifts - morning_survey_min_shifts))

def solve_ilp():
    # Define the problem
    prob = pulp.LpProblem("ShiftScheduling", pulp.LpMinimize)

    # Get data
    persons = Person.query.all()
    shifts = Shift.query.all()

    # Calculate start of next weekday_selection_vars
    now = datetime.now()
    days_until_next_monday = (7 - now.weekday()) % 7
    if days_until_next_monday == 0:
        days_until_next_monday = 7
    start_of_next_week = (now + timedelta(days=days_until_next_monday)).replace(hour=0, minute=0, second=0, microsecond=0)

    # Expand shifts. any_day_groups is a list of lists that each represent a shift that can be assigned to any day.
    all_shifts, any_day_groups = expand_shifts(shifts, start_of_next_week)

    # Define decision variables
    x, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts, day_selection_vars = define_decision_variables(persons, all_shifts, any_day_groups)

    # Add constraints
    add_constraints(prob, persons, all_shifts, x, max_shifts, morning_survey_max_shifts, morning_survey_min_shifts, day_selection_vars, any_day_groups)

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