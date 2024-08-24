from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
import math


app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///rota.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)


# Models for the people and shifts
class Person(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    start_date = db.Column(db.Date, nullable=False)
    leaving_date = db.Column(db.Date, nullable=False)
    leader = db.Column(db.Boolean, default=False)
    part_time = db.Column(db.Boolean, default=False)
    day_off_every = db.Column(db.Integer, default=10, nullable=False)
    days_off_past = db.Column(db.Integer, default=0)
    days_off_total = db.Column(db.Integer, default=0)  # calculated from start_date, leaving_date and days_off_past
    duty_sheet_trained = db.Column(db.Boolean, default=False)
    ms_leader = db.Column(db.Boolean, default=False)
    driver = db.Column(db.Boolean, default=False)

class Shift(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    is_daily = db.Column(db.Boolean, default=False)
    weekly_day = db.Column(db.String(10), nullable=True)  # Only for weekly shifts
    specific_date = db.Column(db.Date, nullable=True)  # Only for one-time shifts
    start_time = db.Column(db.Time, nullable=False)
    end_time = db.Column(db.Time, nullable=False)
    monitoring = db.Column(db.Boolean, default=False)
    pa = db.Column(db.Boolean, default=False)
    other_area = db.Column(db.Boolean, default=False)

with app.app_context():
    db.create_all()


@app.route('/add_person', methods=['POST'])
def add_person():
    name = request.form['name']
    start_date = datetime.strptime(request.form['start_date'], '%Y-%m-%d')
    leaving_date = datetime.strptime(request.form['leaving_date'], '%Y-%m-%d')
    day_off_every = int(request.form.get('day_off_every', "10"))

    # Convert checkboxes from 'on'/'off' to booleans
    leader = 'leader' in request.form  # Checked means True
    part_time = 'part_time' in request.form  # Checked means True
    ms_leader = 'ms_leader' in request.form  # Checked means True
    duty_sheet_trained = 'duty_sheet_trained' in request.form  # Checked means True
    driver = 'driver' in request.form  # Checked means True

    days_off_total = float((leaving_date - start_date).days) / float(day_off_every)
    #round up to nearest integer
    days_off_total = math.ceil(days_off_total)

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
    return redirect(url_for('people'))  # Redirect to the 'people' page

@app.route('/edit_person', methods=['POST'])
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

    return redirect(url_for('people'))

@app.route('/delete_person/<int:person_id>', methods=['POST'])
def delete_person(person_id):
    person = Person.query.get(person_id)
    if person:
        db.session.delete(person)
        db.session.commit()
    return redirect(url_for('people'))

@app.route('/add_shift', methods=['POST'])
def add_shift():
    name = request.form['name']
    type = request.form['type']
    is_daily = type == 'daily'
    weekly_day = request.form.get('weekly_day') if type == 'weekly' else None
    specific_date = datetime.strptime(request.form['specific_date'], '%Y-%m-%d') if type == 'one-time' else None
    start_time = datetime.strptime(request.form['start_time'], '%H:%M').time()
    end_time = datetime.strptime(request.form['end_time'], '%H:%M').time()
    monitoring = 'monitoring' in request.form
    pa = 'pa' in request.form
    other_area = 'other_area' in request.form

    new_shift = Shift(
        name=name,
        is_daily=is_daily,
        weekly_day=weekly_day,
        specific_date=specific_date,
        start_time=start_time,
        end_time=end_time,
        monitoring=monitoring,
        pa=pa,
        other_area=other_area
    )
    db.session.add(new_shift)
    db.session.commit()
    return redirect(url_for('shifts'))

@app.route('/edit_shift', methods=['POST'])
def edit_shift():
    shift_id = request.form['id']
    shift = Shift.query.get(shift_id)

    if shift:
        shift.name = request.form['name']
        type = request.form['type']
        shift.is_daily = type == 'daily'
        shift.weekly_day = request.form.get('weekly_day') if type == 'weekly' else None
        shift.specific_date = datetime.strptime(request.form['specific_date'], '%Y-%m-%d') if type == 'one-time' else None
        shift.start_time = datetime.strptime(request.form['start_time'], '%H:%M').time()
        shift.end_time = datetime.strptime(request.form['end_time'], '%H:%M').time()
        shift.monitoring = 'monitoring' in request.form
        shift.pa = 'pa' in request.form
        shift.other_area = 'other_area' in request.form

        db.session.commit()

    return redirect(url_for('shifts'))

@app.route('/delete_shift/<int:shift_id>', methods=['POST'])
def delete_shift(shift_id):
    shift = Shift.query.get(shift_id)
    if shift:
        db.session.delete(shift)
        db.session.commit()
    return redirect(url_for('shifts'))

@app.route('/shifts')
def shifts():
    shifts = Shift.query.all()
    return render_template('shifts.html', shifts=shifts)


# Main page (Generate Rota)
@app.route('/')
def main():
    return render_template('main.html')


# Rota Request page (Fixed Shifts)
@app.route('/rota_request')
def rota_request():
    return render_template('rota_request.html')


# People page
@app.route('/people')
def people():
    people = Person.query.all()
    return render_template('people.html', people=people)

# Add routes for processing people and shifts (optional, similar to before)
# Add logic for rota generation as needed

if __name__ == '__main__':
    app.run(debug=True)
