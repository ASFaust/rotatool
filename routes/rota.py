from flask import Blueprint, render_template, request, jsonify
from models import db, Person, Shift, ManualShift

rota_bp = Blueprint('rota', __name__, url_prefix='/rota')

@rota_bp.route('/rota_request', methods=['GET'], endpoint='rota_request')
def rota_request():
    active_people = Person.query.filter_by(activated=True).order_by(Person.name).all()
    available_shifts = Shift.query.order_by(Shift.name).all()
    manual_shifts = ManualShift.query.all()
    return render_template('rota_request.html', active_people=active_people, available_shifts=available_shifts, manual_shifts=manual_shifts)

@rota_bp.route('/save_manual_shifts', methods=['POST'], endpoint='save_manual_shifts')
def save_manual_shifts():
    data = request.json
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    # Clear existing manual shifts
    ManualShift.query.delete()
    db.session.commit()

    # Insert new manual shifts
    for shift in data['shifts']:
        if 'day' not in shift:
            return jsonify({'error': 'Missing day in shift data'}), 400
        new_shift = ManualShift(
            person_id=shift['person_id'],
            day=shift['day'],
            shift_id=shift.get('shift_id'),
            non_shift_info=shift.get('non_shift_info')
        )
        db.session.add(new_shift)

    db.session.commit()
    return jsonify({'message': 'Manual shifts saved successfully'}), 200