# routes/people.py
from flask import Blueprint, request, redirect, url_for, render_template
from datetime import datetime
import math
from sqlalchemy.exc import IntegrityError
from models import db, Person

people_bp = Blueprint('people', __name__, url_prefix='/people')

@people_bp.route('/', methods=['GET'], endpoint='people')
def people():
    people = Person.query.all()
    return render_template('people.html', people=people)

@people_bp.route('/add_person', methods=['POST'], endpoint='add_person')
def add_person():
    try:
        name = request.form['name']
        start_date = datetime.strptime(request.form['start_date'], '%Y-%m-%d')
        leaving_date = datetime.strptime(request.form['leaving_date'], '%Y-%m-%d')
        day_off_every = int(request.form.get('day_off_every', "10"))

        leader = 'leader' in request.form
        part_time = 'part_time' in request.form
        ms_leader = 'ms_leader' in request.form
        duty_sheet_trained = 'duty_sheet_trained' in request.form
        driver = 'driver' in request.form

        days_off_total = math.ceil(float((leaving_date - start_date).days) / float(day_off_every))

        new_person = Person(
            name=name,
            start_date=start_date,
            leaving_date=leaving_date,
            leader=leader,
            part_time=part_time,
            day_off_every=day_off_every,
            days_off_past=0,
            days_off_total=days_off_total,
            duty_sheet_trained=duty_sheet_trained,
            ms_leader=ms_leader,
            driver=driver
        )
        db.session.add(new_person)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return "Error: Person with this name already exists.", 400
    return redirect(url_for('people.people'))

@people_bp.route('/edit_person', methods=['POST'], endpoint='edit_person')
def edit_person():
    person_id = request.form['id']
    person = Person.query.get(person_id)

    if person:
        person.name = request.form['name']
        person.start_date = datetime.strptime(request.form['start_date'], '%Y-%m-%d')
        person.leaving_date = datetime.strptime(request.form['leaving_date'], '%Y-%m-%d')
        person.leader = 'leader' in request.form
        person.part_time = 'part_time' in request.form
        person.days_off_past = int(request.form['days_off_past'])
        person.days_off_total = int(request.form['days_off_total'])
        person.day_off_every = int(request.form['day_off_every'])
        person.duty_sheet_trained = 'duty_sheet_trained' in request.form
        person.ms_leader = 'ms_leader' in request.form
        person.driver = 'driver' in request.form

        db.session.commit()

    return redirect(url_for('people.edit_person'))

@people_bp.route('/delete_person/<int:person_id>', methods=['POST'], endpoint='delete_person')
def delete_person(person_id):
    person = Person.query.get(person_id)
    if person:
        db.session.delete(person)
        db.session.commit()
    return redirect(url_for('people.delete_person'))