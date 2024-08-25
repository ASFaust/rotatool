# routes/shifts.py
from flask import Blueprint, request, redirect, url_for
from datetime import datetime
from sqlalchemy.exc import IntegrityError
from models import db, Shift

shifts_bp = Blueprint('shifts', __name__, url_prefix='/shifts')

@shifts_bp.route('/add_shift', methods=['POST'], endpoint='add_shift')
def add_shift():
    try:
        name = request.form['name']
        is_daily = 'is_daily' in request.form
        day_of_the_week = request.form.get('day_of_the_week') if not is_daily else None
        start_time = datetime.strptime(request.form['start_time'], '%H:%M').time()
        end_time = datetime.strptime(request.form['end_time'], '%H:%M').time()
        monitoring = 'monitoring' in request.form
        pa = 'pa' in request.form
        other_area = 'other_area' in request.form

        new_shift = Shift(
            name=name,
            is_daily=is_daily,
            day_of_the_week=day_of_the_week,
            start_time=start_time,
            end_time=end_time,
            monitoring=monitoring,
            pa=pa,
            other_area=other_area
        )
        db.session.add(new_shift)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return "Error: Shift with this name already exists.", 400
    return redirect(url_for('shifts.add_shift'))

@shifts_bp.route('/edit_shift', methods=['POST'], endpoint='edit_shift')
def edit_shift():
    shift_id = request.form['id']
    shift = Shift.query.get(shift_id)

    if shift:
        shift.name = request.form['name']
        shift.is_daily = 'is_daily' in request.form
        shift.day_of_the_week = request.form.get('day_of_the_week') if not shift.is_daily else None
        shift.start_time = datetime.strptime(request.form['start_time'], '%H:%M').time()
        shift.end_time = datetime.strptime(request.form['end_time'], '%H:%M').time()
        shift.monitoring = 'monitoring' in request.form
        shift.pa = 'pa' in request.form
        shift.other_area = 'other_area' in request.form

        db.session.commit()

    return redirect(url_for('shifts.edit_shift'))

@shifts_bp.route('/delete_shift/<int:shift_id>', methods=['POST'], endpoint='delete_shift')
def delete_shift(shift_id):
    shift = Shift.query.get(shift_id)
    if shift:
        db.session.delete(shift)
        db.session.commit()
    return redirect(url_for('shifts.delete_shift'))